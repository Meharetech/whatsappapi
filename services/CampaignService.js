import WhatsAppService from "./WhatsAppService.js";
import { WhatsAppSession, Message, Campaign } from "../models/index.js";
import mongoose from "mongoose";
import SubscriptionService from "./SubscriptionService.js";

class CampaignService {
  constructor() {
    this.activeCampaigns = new Map();
    this.io = null;
  }

  async findUserSession(userId, sessionRef) {
    const baseQuery = { userId: new mongoose.Types.ObjectId(userId) };

    if (typeof sessionRef === "string" && sessionRef.startsWith("wa_")) {
      return WhatsAppSession.findOne({ ...baseQuery, sessionId: sessionRef });
    }

    if (mongoose.Types.ObjectId.isValid(sessionRef)) {
      return WhatsAppSession.findOne({
        ...baseQuery,
        _id: new mongoose.Types.ObjectId(sessionRef),
      });
    }

    // Fallback for unexpected but valid-looking values
    return WhatsAppSession.findOne({ ...baseQuery, sessionId: sessionRef });
  }

  setSocketIO(io) {
    this.io = io;
  }

  emit(event, data) {
    if (this.io) {
      this.io.emit(event, data);
    }
  }

  async createCampaign(
    userId,
    sessionId,
    name,
    message,
    numbers,
    delaySeconds = 10,
  ) {
    const session = await this.findUserSession(userId, sessionId);

    if (!session) {
      throw new Error("Session not found");
    }

    if (session.status !== "connected") {
      throw new Error("Session is not connected");
    }

    const campaign = new Campaign({
      userId: new mongoose.Types.ObjectId(userId),
      sessionId: session._id,
      name,
      message,
      numbers: this.normalizeNumbers(numbers),
      status: "draft",
      delaySeconds,
      sentCount: 0,
      failedCount: 0,
      currentIndex: 0,
    });

    await campaign.save();

    return {
      campaignId: campaign._id,
      name: campaign.name,
      totalNumbers: campaign.numbers.length,
      status: campaign.status,
    };
  }

  normalizeNumbers(numbers) {
    return numbers
      .map((num) => {
        let clean = num.replace(/\D/g, "");
        if (clean.length === 10) {
          clean = "91" + clean;
        }
        return clean;
      })
      .filter((num) => num.length >= 12);
  }

  async startCampaign(campaignId, userId) {
    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.status !== "draft" && campaign.status !== "cancelled") {
      throw new Error("Campaign cannot be started");
    }

    campaign.status = "running";
    campaign.currentIndex = 0;
    await campaign.save();

    this.activeCampaigns.set(campaignId.toString(), {
      running: true,
      cancelled: false,
    });

    this.emit("campaign:started", {
      campaignId: campaign._id,
      name: campaign.name,
    });

    this.processCampaign(campaign);

    return {
      campaignId: campaign._id,
      status: campaign.status,
      totalNumbers: campaign.numbers.length,
    };
  }

  async processCampaign(campaign) {
    const campaignId = campaign._id.toString();
    const session = await WhatsAppSession.findById(campaign.sessionId);

    if (!session) {
      await this.failCampaign(campaign, "Session not found");
      return;
    }

    const sessionId = session.sessionId;
    const numbers = campaign.numbers;
    const message = campaign.message;
    const delayMs = campaign.delaySeconds * 1000;

    for (let i = campaign.currentIndex; i < numbers.length; i++) {
      const control = this.activeCampaigns.get(campaignId);

      if (!control || !control.running) {
        if (control && control.cancelled) {
          await Campaign.updateOne(
            { _id: campaign._id },
            { status: "cancelled" },
          );
          this.emit("campaign:cancelled", { campaignId: campaign._id });
        }
        return;
      }

      await Campaign.updateOne({ _id: campaign._id }, { currentIndex: i });

      const phoneNumber = numbers[i];
      const msgDoc = new Message({
        sessionId: campaign.sessionId,
        campaignId: campaign._id,
        phoneNumber,
        message,
        status: "pending",
      });
      await msgDoc.save();

      this.emit("message:processing", {
        campaignId: campaign._id,
        index: i,
        total: numbers.length,
        phoneNumber,
      });

      try {
        await SubscriptionService.assertMessageQuota(
          { _id: campaign.userId },
          1,
        );

        await WhatsAppService.sendMessage(sessionId, phoneNumber, message);

        await SubscriptionService.consumeMessageQuota(campaign.userId, 1);

        await Message.updateOne(
          { _id: msgDoc._id },
          { status: "sent", sentAt: new Date() },
        );

        await Campaign.updateOne(
          { _id: campaign._id },
          { $inc: { sentCount: 1 } },
        );

        this.emit("message:sent", {
          campaignId: campaign._id,
          phoneNumber,
          index: i,
          total: numbers.length,
        });
      } catch (err) {
        await Message.updateOne(
          { _id: msgDoc._id },
          { status: "failed", error: err.message },
        );

        await Campaign.updateOne(
          { _id: campaign._id },
          { $inc: { failedCount: 1 } },
        );

        this.emit("message:failed", {
          campaignId: campaign._id,
          phoneNumber,
          error: err.message,
          index: i,
          total: numbers.length,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    await Campaign.updateOne({ _id: campaign._id }, { status: "completed" });
    this.activeCampaigns.delete(campaignId);

    this.emit("campaign:completed", {
      campaignId: campaign._id,
      sentCount: campaign.sentCount + 1,
      failedCount: campaign.failedCount,
    });
  }

  async cancelCampaign(campaignId, userId) {
    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      throw new Error("Campaign not found");
    }

    if (campaign.status !== "running") {
      throw new Error("Campaign is not running");
    }

    const control = this.activeCampaigns.get(campaignId.toString());
    if (control) {
      control.running = false;
      control.cancelled = true;
    }

    campaign.status = "cancelled";
    await campaign.save();

    this.emit("campaign:cancelled", { campaignId: campaign._id });

    return {
      campaignId: campaign._id,
      status: campaign.status,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
    };
  }

  async failCampaign(campaign, error) {
    campaign.status = "failed";
    await campaign.save();

    this.emit("campaign:failed", {
      campaignId: campaign._id,
      error,
    });
  }

  async getCampaign(campaignId, userId) {
    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(campaignId),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      return null;
    }

    return {
      campaignId: campaign._id,
      name: campaign.name,
      sessionId: campaign.sessionId,
      status: campaign.status,
      totalNumbers: campaign.numbers.length,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      currentIndex: campaign.currentIndex,
      delaySeconds: campaign.delaySeconds,
      createdAt: campaign.createdAt,
    };
  }

  async listCampaigns(userId) {
    const campaigns = await Campaign.find({
      userId: new mongoose.Types.ObjectId(userId),
    }).sort({ createdAt: -1 });

    return campaigns.map((c) => ({
      campaignId: c._id,
      name: c.name,
      status: c.status,
      totalNumbers: c.numbers.length,
      sentCount: c.sentCount,
      failedCount: c.failedCount,
      createdAt: c.createdAt,
    }));
  }

  async sendSingleMessage(
    userId,
    sessionId,
    phoneNumber,
    message,
    contactName = "",
    mediaPath = null,
    mediaType = null,
  ) {
    const session = await this.findUserSession(userId, sessionId);

    if (!session) {
      throw new Error("Session not found");
    }

    if (session.status !== "connected") {
      throw new Error("Session is not connected");
    }

    // If a full JID is passed (contains @), use it as-is; otherwise normalise digits
    let jid;
    if (String(phoneNumber).includes("@")) {
      jid = phoneNumber;
    } else {
      jid = String(phoneNumber).replace(/\D/g, "");
      if (jid.length === 10) jid = "91" + jid;
    }

    const msgDoc = new Message({
      sessionId: session._id,
      phoneNumber: jid,
      contactName,
      message,
      messageType: "single",
      status: "pending",
    });

    try {
      await SubscriptionService.assertMessageQuota({ _id: userId }, 1);

      // Send message with optional media
      await WhatsAppService.sendMessage(
        session.sessionId,
        jid,
        message,
        mediaPath,
        mediaType,
      );

      await SubscriptionService.consumeMessageQuota(userId, 1);

      msgDoc.status = "sent";
      msgDoc.sentAt = new Date();
      await msgDoc.save();

      return {
        success: true,
        messageId: `msg_${msgDoc._id}`,
        to: jid,
        status: "sent",
        timestamp: msgDoc.sentAt.toISOString(),
      };
    } catch (err) {
      msgDoc.status = "failed";
      msgDoc.error = err.message;
      await msgDoc.save();

      throw err;
    }
  }
}

export default new CampaignService();
