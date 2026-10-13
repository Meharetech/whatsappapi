import { DripCampaign, DripRecipient, NumberList } from "../models/index.js";
import dripService from "../services/DripService.js";

export const listCampaigns = async (req, res) => {
  try {
    const campaigns = await DripCampaign.find({ userId: req.user._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getCampaign = async (req, res) => {
  try {
    const campaign = await DripCampaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const createCampaign = async (req, res) => {
  try {
    const { name, description, sessionId, steps = [], settings = {} } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Campaign name is required" });
    }

    if (!sessionId) {
      return res.status(400).json({ success: false, error: "WhatsApp Session is required" });
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ success: false, error: "At least one step is required" });
    }

    const formattedSteps = steps.map((s, idx) => ({
      stepIndex: idx + 1,
      delayValue: Number(s.delayValue) >= 0 ? Number(s.delayValue) : (idx === 0 ? 0 : 1),
      delayUnit: ["minutes", "hours", "days"].includes(s.delayUnit) ? s.delayUnit : "days",
      message: s.message || "",
      mediaUrl: s.mediaUrl || null,
      mediaType: s.mediaType || null,
      mediaName: s.mediaName || null,
    }));

    const campaign = new DripCampaign({
      userId: req.user._id,
      name: name.trim(),
      description: description || "",
      sessionId,
      status: "active",
      steps: formattedSteps,
      settings: {
        stopOnReply: settings.stopOnReply !== false,
        notifyOnReply: settings.notifyOnReply !== false,
        sendWindow: {
          enabled: !!settings?.sendWindow?.enabled,
          startHour: Number(settings?.sendWindow?.startHour) || 9,
          endHour: Number(settings?.sendWindow?.endHour) || 20,
        },
      },
    });

    await campaign.save();

    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const updateCampaign = async (req, res) => {
  try {
    const { name, description, sessionId, steps, settings, status } = req.body;

    const campaign = await DripCampaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    if (name) campaign.name = name.trim();
    if (description !== undefined) campaign.description = description;
    if (sessionId) campaign.sessionId = sessionId;
    if (status) campaign.status = status;

    if (Array.isArray(steps) && steps.length > 0) {
      campaign.steps = steps.map((s, idx) => ({
        stepIndex: idx + 1,
        delayValue: Number(s.delayValue) >= 0 ? Number(s.delayValue) : (idx === 0 ? 0 : 1),
        delayUnit: ["minutes", "hours", "days"].includes(s.delayUnit) ? s.delayUnit : "days",
        message: s.message || "",
        mediaUrl: s.mediaUrl || null,
        mediaType: s.mediaType || null,
        mediaName: s.mediaName || null,
      }));
    }

    if (settings) {
      campaign.settings = {
        stopOnReply: settings.stopOnReply !== false,
        notifyOnReply: settings.notifyOnReply !== false,
        sendWindow: {
          enabled: !!settings?.sendWindow?.enabled,
          startHour: Number(settings?.sendWindow?.startHour) || 9,
          endHour: Number(settings?.sendWindow?.endHour) || 20,
        },
      };
    }

    await campaign.save();

    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const deleteCampaign = async (req, res) => {
  try {
    const campaign = await DripCampaign.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    await DripRecipient.deleteMany({ dripCampaignId: req.params.id });

    res.json({ success: true, message: "Campaign and recipients deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const duplicateCampaign = async (req, res) => {
  try {
    const source = await DripCampaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).lean();

    if (!source) {
      return res.status(404).json({ success: false, error: "Source campaign not found" });
    }

    const cloned = new DripCampaign({
      userId: req.user._id,
      name: `${source.name} (Copy)`,
      description: source.description || "",
      sessionId: source.sessionId,
      status: "active",
      steps: source.steps,
      settings: source.settings,
    });

    await cloned.save();
    res.status(201).json({ success: true, data: cloned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const toggleStatus = async (req, res) => {
  try {
    const campaign = await DripCampaign.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });

    if (!campaign) {
      return res.status(404).json({ success: false, error: "Campaign not found" });
    }

    campaign.status = campaign.status === "active" ? "paused" : "active";
    await campaign.save();

    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const enrollContacts = async (req, res) => {
  try {
    const { contacts = [], numberListId } = req.body;
    let contactList = [...contacts];

    if (numberListId) {
      const numList = await NumberList.findOne({
        _id: numberListId,
        userId: req.user._id,
      }).lean();

      if (numList && Array.isArray(numList.numbers)) {
        numList.numbers.forEach((n) => {
          contactList.push({
            phone: n.number || n.phone || n,
            name: n.name || "",
          });
        });
      }
    }

    if (!contactList || contactList.length === 0) {
      return res.status(400).json({ success: false, error: "No valid contacts provided" });
    }

    const result = await dripService.enrollContacts(
      req.params.id,
      contactList,
      req.user._id
    );

    res.json({
      success: true,
      message: `Successfully enrolled ${result.enrolledCount} contacts into sequence`,
      enrolledCount: result.enrolledCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const listRecipients = async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search, step } = req.query;
    const query = {
      dripCampaignId: req.params.id,
      userId: req.user._id,
    };

    if (status && status !== "all") {
      query.status = status;
    }

    if (step && step !== "all") {
      query.currentStep = Number(step);
    }

    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { phone: new RegExp(s, "i") },
        { contactName: new RegExp(s, "i") },
        { replyMessage: new RegExp(s, "i") },
      ];
    }

    const total = await DripRecipient.countDocuments(query);
    const recipients = await DripRecipient.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    res.json({
      success: true,
      data: recipients,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const listAllLeads = async (req, res) => {
  try {
    const { page = 1, limit = 50, status, search, campaignId } = req.query;
    const query = {
      userId: req.user._id,
    };

    if (campaignId && campaignId !== "all") {
      query.dripCampaignId = campaignId;
    }

    if (status && status !== "all") {
      query.status = status;
    }

    if (search && search.trim()) {
      const s = search.trim();
      query.$or = [
        { phone: new RegExp(s, "i") },
        { contactName: new RegExp(s, "i") },
        { replyMessage: new RegExp(s, "i") },
      ];
    }

    const total = await DripRecipient.countDocuments(query);
    const recipients = await DripRecipient.find(query)
      .populate("dripCampaignId", "name sessionId steps status")
      .sort({ repliedAt: -1, updatedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit))
      .lean();

    res.json({
      success: true,
      data: recipients,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getFunnel = async (req, res) => {
  try {
    const funnelData = await dripService.getFunnelStats(req.params.id, req.user._id);
    res.json({ success: true, data: funnelData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const triggerRecipientNow = async (req, res) => {
  try {
    const result = await dripService.triggerRecipientNow(req.params.recipientId, req.user._id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const skipRecipientStep = async (req, res) => {
  try {
    const result = await dripService.skipRecipientStep(req.params.recipientId, req.user._id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const resumeRecipient = async (req, res) => {
  try {
    const result = await dripService.resumeRecipient(req.params.recipientId, req.user._id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const cancelRecipient = async (req, res) => {
  try {
    const recipient = await DripRecipient.findOne({
      _id: req.params.recipientId,
      dripCampaignId: req.params.id,
      userId: req.user._id,
    });

    if (!recipient) {
      return res.status(404).json({ success: false, error: "Recipient not found" });
    }

    if (recipient.status === "active") {
      recipient.status = "paused";
      recipient.nextExecutionTime = null;
      await recipient.save();

      await DripCampaign.findByIdAndUpdate(recipient.dripCampaignId, {
        $inc: { "stats.activeCount": -1 },
      });
    }

    res.json({ success: true, message: "Recipient stopped from sequence" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const exportLeads = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {
      dripCampaignId: req.params.id,
      userId: req.user._id,
    };
    if (status && status !== "all") query.status = status;

    const recipients = await DripRecipient.find(query).sort({ createdAt: -1 }).lean();

    const csvHeaders = [
      "Phone Number",
      "Contact Name",
      "Status",
      "Current Step",
      "Next Scheduled Send",
      "Enrolled At",
      "Last Message Sent At",
      "Replied At",
      "Reply Text",
      "Replied on Step",
      "Reply Latency (Minutes)",
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const csvRows = recipients.map((r) => [
      escapeCsv(r.phone),
      escapeCsv(r.contactName),
      escapeCsv(r.status),
      escapeCsv(r.currentStep),
      escapeCsv(r.nextExecutionTime ? new Date(r.nextExecutionTime).toISOString() : ""),
      escapeCsv(r.enrolledAt ? new Date(r.enrolledAt).toISOString() : ""),
      escapeCsv(r.lastSentAt ? new Date(r.lastSentAt).toISOString() : ""),
      escapeCsv(r.repliedAt ? new Date(r.repliedAt).toISOString() : ""),
      escapeCsv(r.replyMessage || ""),
      escapeCsv(r.replyStepIndex || ""),
      escapeCsv(r.replyLatencyMinutes || ""),
    ].join(","));

    const csvContent = [csvHeaders.join(","), ...csvRows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="drip_leads_${req.params.id}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const markRecipientReplied = async (req, res) => {
  try {
    const { message = "Customer replied (manual confirmation)" } = req.body;
    const recipient = await DripRecipient.findOne({
      _id: req.params.recipientId,
      dripCampaignId: req.params.id,
      userId: req.user._id,
    }).populate("dripCampaignId");

    if (!recipient) {
      return res.status(404).json({ success: false, error: "Recipient not found" });
    }

    if (recipient.status === "active") {
      const now = new Date();
      recipient.status = "replied";
      recipient.repliedAt = now;
      recipient.replyMessage = message;
      recipient.replyStepIndex = recipient.currentStep || 1;
      recipient.nextExecutionTime = null;
      recipient.nextStepPreview = "";

      recipient.logs.push({
        stepIndex: recipient.currentStep || 1,
        stepName: `Customer Reply to Step #${recipient.currentStep || 1}`,
        sentAt: now,
        executedAt: now,
        status: "sent",
        messagePreview: `Reply: ${message}`,
        deliveryStatus: "replied",
      });

      await recipient.save();

      await DripCampaign.findByIdAndUpdate(recipient.dripCampaignId._id, {
        $inc: { "stats.activeCount": -1, "stats.repliedCount": 1 },
      });
    }

    res.json({ success: true, message: "Lead marked as replied and removed from sequence", recipient });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export default {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  duplicateCampaign,
  toggleStatus,
  enrollContacts,
  listRecipients,
  listAllLeads,
  getFunnel,
  triggerRecipientNow,
  skipRecipientStep,
  resumeRecipient,
  cancelRecipient,
  markRecipientReplied,
  exportLeads,
};
