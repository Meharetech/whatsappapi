import { WhatsAppSession, Message } from "../models/index.js";
import CampaignService from "../services/CampaignService.js";
import mongoose from "mongoose";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sendSubscriptionError } from "../utils/subscription.js";

export const sendMessage = async (req, res) => {
  let tempFilePath = null;

  try {
    const body = req.body;
    // Accept both field name styles:
    //   API-key users:   { session, to, message, contactName }
    //   Internal/legacy: { sessionId, phoneNumber, message, contactName }
    const sessionId = body.sessionId || body.session;
    const phoneNumber = body.phoneNumber || body.to;
    const { message, contactName, mediaBase64, mediaType, mediaName } = body;

    if (!sessionId || !phoneNumber || !message) {
      return res
        .status(400)
        .json({
          error:
            "session (or sessionId), to (or phoneNumber), and message are required",
        });
    }

    let mediaPath = null;

    // Handle base64 encoded media
    if (mediaBase64 && mediaType) {
      try {
        // Convert base64 to buffer
        const buffer = Buffer.from(mediaBase64, "base64");

        // Create temp file
        tempFilePath = join(
          tmpdir(),
          `whatsapp-media-${Date.now()}-${mediaName || "file"}`,
        );
        writeFileSync(tempFilePath, buffer);

        mediaPath = tempFilePath;
      } catch (err) {
        return res
          .status(400)
          .json({ error: `Failed to process media: ${err.message}` });
      }
    }

    try {
      const result = await CampaignService.sendSingleMessage(
        req.user._id,
        sessionId,
        phoneNumber,
        message,
        contactName,
        mediaPath,
        mediaType,
      );

      res.json(result);
    } finally {
      // Clean up temp file
      if (tempFilePath) {
        try {
          unlinkSync(tempFilePath);
        } catch (err) {
          console.error("Failed to clean up temp file:", err.message);
        }
      }
    }
  } catch (err) {
    if (tempFilePath) {
      try {
        unlinkSync(tempFilePath);
      } catch (e) {
        console.error("Failed to clean up temp file:", e.message);
      }
    }
    return sendSubscriptionError(res, err, "Failed to send message");
  }
};

export const getSessionMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const messages = await Message.find({ sessionId: session._id })
      .sort({ createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit));

    const total = await Message.countDocuments({ sessionId: session._id });

    res.json({
      messages: messages.map((m) => ({
        messageId: m._id,
        phoneNumber: m.phoneNumber,
        contactName: m.contactName,
        message: m.message,
        status: m.status,
        error: m.error,
        sentAt: m.sentAt,
        deliveredAt: m.deliveredAt,
        readAt: m.readAt,
        createdAt: m.createdAt,
      })),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updateMessageStatus = async (req, res) => {
  try {
    const { messageId, status } = req.body;

    if (!messageId || !status) {
      return res
        .status(400)
        .json({ error: "messageId and status are required" });
    }

    // Validate status
    const validStatuses = ["pending", "sent", "failed", "delivered", "read"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        });
    }

    // Build update object
    const updateData = { status };
    if (status === "delivered") {
      updateData.deliveredAt = new Date();
    } else if (status === "read") {
      updateData.readAt = new Date();
    }

    // Update message
    const message = await Message.findByIdAndUpdate(messageId, updateData, {
      new: true,
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found" });
    }

    res.json({
      success: true,
      message: {
        messageId: message._id,
        phoneNumber: message.phoneNumber,
        status: message.status,
        deliveredAt: message.deliveredAt,
        readAt: message.readAt,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default { sendMessage, getSessionMessages, updateMessageStatus };
