import MetaMessage from "../models/MetaMessage.js";
import MetaCampaign from "../models/MetaCampaign.js";
import WABAccount from "../models/WABAccount.js";
import PhoneNumber from "../models/PhoneNumber.js";
import MessageTemplate from "../models/MessageTemplate.js";
import MetaApiService from "../services/MetaApiService.js";

async function getWABAWithToken(wabaDbId, userId) {
  const waba = await WABAccount.findOne({ _id: wabaDbId, userId, status: "active" }).select("+accessToken");
  if (!waba) throw new Error("WABA not found");
  return waba;
}

// POST /api/meta/messages/send
// Body: { wabaId, phoneNumberId, to, type, body?, templateName?, templateLanguage?, templateComponents? }
export async function sendMessage(req, res) {
  try {
    const { wabaId, phoneNumberId, to, type, body, templateName, templateLanguage, templateComponents } = req.body;
    if (!wabaId || !phoneNumberId || !to) {
      return res.status(400).json({ success: false, error: "wabaId, phoneNumberId, to are required" });
    }

    const waba = await getWABAWithToken(wabaId, req.user._id);

    let metaResult;
    if (type === "template") {
      metaResult = await MetaApiService.sendTemplateMessage(
        phoneNumberId, to, templateName, templateLanguage || "en_US",
        templateComponents || [], waba.accessToken
      );
    } else {
      metaResult = await MetaApiService.sendTextMessage(phoneNumberId, to, body, waba.accessToken);
    }

    const msgId = metaResult.messages?.[0]?.id || "";

    const msg = await MetaMessage.create({
      userId: req.user._id,
      wabaId,
      phoneNumberId,
      to,
      messageId: msgId,
      type: type || "text",
      body: body || "",
      templateName: templateName || "",
      templateLanguage: templateLanguage || "",
      templateComponents: templateComponents || [],
      status: "sent",
    });

    res.json({ success: true, data: msg, metaMessageId: msgId });
  } catch (err) {
    console.error("[Messaging] sendMessage:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// GET /api/meta/messages
export async function getMessages(req, res) {
  try {
    const { wabaId, to, status, page = 1, limit = 50 } = req.query;
    const filter = { userId: req.user._id };
    if (wabaId) filter.wabaId = wabaId;
    if (to) filter.to = { $regex: to, $options: "i" };
    if (status) filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [messages, total] = await Promise.all([
      MetaMessage.find(filter).sort("-createdAt").skip(skip).limit(Number(limit)).lean(),
      MetaMessage.countDocuments(filter),
    ]);

    res.json({ success: true, data: messages, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/campaigns
export async function createCampaign(req, res) {
  try {
    const { wabaId, phoneNumberId, name, templateId, recipients, scheduledFor, delayMs } = req.body;
    if (!wabaId || !phoneNumberId || !name || !templateId || !recipients?.length) {
      return res.status(400).json({ success: false, error: "Missing required fields" });
    }

    const template = await MessageTemplate.findOne({ _id: templateId, userId: req.user._id });
    if (!template) return res.status(404).json({ success: false, error: "Template not found" });
    if (template.status !== "APPROVED") {
      return res.status(400).json({ success: false, error: "Template must be APPROVED to run campaign" });
    }

    const campaign = await MetaCampaign.create({
      userId: req.user._id,
      wabaId,
      phoneNumberId,
      name,
      templateId,
      templateName: template.name,
      templateLanguage: template.language,
      recipients,
      totalCount: recipients.length,
      scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
      delayMs: delayMs || 1000,
      status: scheduledFor ? "scheduled" : "draft",
    });

    res.status(201).json({ success: true, data: campaign });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

// POST /api/meta/campaigns/:id/start
export async function startCampaign(req, res) {
  try {
    const campaign = await MetaCampaign.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ success: false, error: "Campaign not found" });
    if (!["draft", "scheduled"].includes(campaign.status)) {
      return res.status(400).json({ success: false, error: "Campaign cannot be started" });
    }

    const waba = await getWABAWithToken(String(campaign.wabaId), req.user._id);
    campaign.status = "running";
    campaign.startedAt = new Date();
    await campaign.save();

    // Fire and forget - process in background
    processCampaign(campaign, waba).catch((err) => {
      console.error("[Campaign] Error:", err.message);
    });

    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

async function processCampaign(campaign, waba) {
  for (const recipient of campaign.recipients) {
    try {
      const result = await MetaApiService.sendTemplateMessage(
        campaign.phoneNumberId,
        recipient.phone,
        campaign.templateName,
        campaign.templateLanguage,
        buildTemplateComponents(campaign.templateComponents, recipient.variables),
        waba.accessToken
      );

      await MetaMessage.create({
        userId: campaign.userId,
        wabaId: campaign.wabaId,
        phoneNumberId: campaign.phoneNumberId,
        to: recipient.phone,
        messageId: result.messages?.[0]?.id || "",
        type: "template",
        templateName: campaign.templateName,
        templateLanguage: campaign.templateLanguage,
        status: "sent",
        campaignId: campaign._id,
      });

      campaign.sentCount++;
      await campaign.save();
    } catch (e) {
      campaign.failedCount++;
      await campaign.save();
    }

    if (campaign.delayMs > 0) {
      await new Promise((r) => setTimeout(r, campaign.delayMs));
    }
  }

  campaign.status = "completed";
  campaign.completedAt = new Date();
  await campaign.save();
}

function buildTemplateComponents(baseComponents, variables) {
  if (!variables || !baseComponents) return baseComponents || [];
  return baseComponents.map((c) => {
    if (c.type === "body" && variables) {
      return {
        ...c,
        parameters: Object.values(variables).map((v) => ({ type: "text", text: String(v) })),
      };
    }
    return c;
  });
}

// GET /api/meta/campaigns
export async function getCampaigns(req, res) {
  try {
    const campaigns = await MetaCampaign.find({ userId: req.user._id })
      .populate("templateId", "name status")
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: campaigns });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/campaigns/:id
export async function getCampaignById(req, res) {
  try {
    const campaign = await MetaCampaign.findOne({ _id: req.params.id, userId: req.user._id })
      .populate("templateId", "name status language");
    if (!campaign) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: campaign });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
