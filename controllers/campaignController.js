import Campaign from "../models/Campaign.js";
import NumberList from "../models/NumberList.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import Message from "../models/Message.js";
import mongoose from "mongoose";
import WhatsAppService from "../services/WhatsAppService.js";
import SubscriptionService from "../services/SubscriptionService.js";
import { sendSubscriptionError } from "../utils/subscription.js";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { formatFilePath } from "../utils/fileUpload.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.join(__dirname, "../uploads");

function getUploadedFileType(mimetype = "") {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.includes("pdf")) return "pdf";
  if (mimetype.includes("audio")) return "audio";
  return "document";
}

function removeUploadedFile(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {
    // Ignore cleanup failures.
  }
}

// Upload a file for a campaign and return a lightweight URL payload.
export const uploadCampaignMedia = async (req, res) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file provided" });
    }

    await SubscriptionService.assertStorageLimit(req.user, req.file.size || 0);

    return res.status(201).json({
      success: true,
      data: {
        url: formatFilePath(req.file.filename),
        type: getUploadedFileType(req.file.mimetype),
        name: req.file.originalname,
        size: req.file.size,
        fileSize: req.file.size,
      },
    });
  } catch (error) {
    removeUploadedFile(req.file?.path);
    return sendSubscriptionError(res, error, "Failed to upload campaign media");
  }
};

// Create Campaign
export const createCampaign = async (req, res) => {
  try {
    const {
      name,
      description,
      type,
      message,
      numberListId,
      sessionId,
      mode,
      startTime,
      scheduledFor,
      delaySeconds,
      minDelay,
      maxDelay,
      randomizeDelay,
      autoRetry,
      mediaUrl,
      mediaType,
      mediaName,
      mediaFiles,
      repeat,
      sessions,
      multiSession,
    } = req.body;
    const userId = req.user.id;

    await SubscriptionService.assertResourceLimit(req.user, "campaigns", 1);

    // Validate required fields
    if (!name || !type || !message || !numberListId || !sessionId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing required fields" });
    }

    // Verify session exists and belongs to user
    const session = await WhatsAppSession.findOne({
      userId,
      $or: [
        ...(mongoose.Types.ObjectId.isValid(sessionId) ? [{ _id: sessionId }] : []),
        { sessionId: sessionId },
      ],
    });
    if (!session) {
      return res
        .status(404)
        .json({ success: false, error: "WhatsApp session not found" });
    }

    if (session.status !== "connected") {
      return res
        .status(400)
        .json({ success: false, error: "WhatsApp session is not connected" });
    }

    // Validate number list exists and belongs to user
    const numberList = await NumberList.findOne({ _id: numberListId, userId });
    if (!numberList) {
      return res
        .status(404)
        .json({ success: false, error: "Number list not found" });
    }

    // Normalize mode: frontend sends "delayed" → store as "interval"
    const normalizedMode = mode === "delayed" ? "interval" : mode || "instant";

    // Determine delay based on mode
    let finalDelaySeconds = 0;
    if (normalizedMode === "interval" || normalizedMode === "scheduled") {
      finalDelaySeconds = Math.max(Number(delaySeconds) || 10, 0);
    }

    // Create campaign
    const campaign = new Campaign({
      userId: new mongoose.Types.ObjectId(userId),
      name,
      description,
      type,
      message,
      numberListId: new mongoose.Types.ObjectId(numberListId),
      sessionId: session._id,
      mode: normalizedMode,
      startTime,
      scheduledFor:
        normalizedMode === "scheduled" ? new Date(scheduledFor) : null,
      delaySeconds: finalDelaySeconds,
      minDelay: Number(minDelay) || 10,
      maxDelay: Number(maxDelay) || 30,
      randomizeDelay: !!randomizeDelay,
      autoRetry: !!autoRetry,
      repeat:
        repeat && typeof repeat === "object"
          ? {
              enabled: !!repeat.enabled,
              type: repeat.type || "daily",
              time: repeat.time || "09:00",
              days: Array.isArray(repeat.days) ? repeat.days : [],
            }
          : { enabled: false, type: "daily", time: "09:00", days: [] },
      // Multi-session
      sessions: (() => {
        const ids =
          Array.isArray(sessions) && sessions.length > 0
            ? sessions
            : [session._id];
        return [...new Set(ids)]
          .map((id) => (mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : session._id))
          .filter(Boolean);
      })(),
      multiSession: {
        enabled: !!(
          multiSession?.enabled &&
          Array.isArray(sessions) &&
          sessions.length > 1
        ),
        mode: multiSession?.mode === "round-robin" ? "round-robin" : "split",
      },
      status: normalizedMode === "scheduled" ? "scheduled" : "draft",
      // Normalize media: prefer new mediaFiles array, fall back to legacy single fields
      mediaFiles: (() => {
        if (Array.isArray(mediaFiles) && mediaFiles.length > 0) {
          return mediaFiles
            .filter((m) => m.url)
            .map((m) => ({
              url: m.url,
              type: m.type || "image",
              name: m.name || "file",
            }));
        }
        if (mediaUrl)
          return [
            {
              url: mediaUrl,
              type: mediaType || "image",
              name: mediaName || "file",
            },
          ];
        return [];
      })(),
      mediaUrl: mediaUrl || null,
      mediaType: mediaType || null,
      mediaName: mediaName || null,
      stats: {
        total: numberList.numbers.length,
        sent: 0,
        delivered: 0,
        failed: 0,
        pending: numberList.numbers.length,
      },
    });

    // Initialize message log
    campaign.messageLog = numberList.numbers.map((phone) => ({
      phoneNumber: phone,
      status: "pending",
      retryCount: 0,
    }));

    await campaign.save();

    res.status(201).json({
      success: true,
      data: campaign,
      message: "Campaign created successfully",
    });
  } catch (error) {
    console.error("Error creating campaign:", error);
    return sendSubscriptionError(res, error, "Failed to create campaign");
  }
};

// Get all campaigns for user
export const getCampaigns = async (req, res) => {
  try {
    const userId = req.user.id;
    const { status, type, search } = req.query;

    let query = { userId: new mongoose.Types.ObjectId(userId) };

    if (status && status !== "all") {
      query.status = status;
    }

    if (type && type !== "all") {
      query.type = type;
    }

    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const campaigns = await Campaign.find(query)
      .populate("numberListId", "name")
      .populate("sessionId", "sessionId phone")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, data: campaigns });
  } catch (error) {
    console.error("Error fetching campaigns:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get single campaign with details
export const getCampaignDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    })
      .populate("numberListId")
      .populate("sessionId");

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    res.json({ success: true, data: campaign });
  } catch (error) {
    console.error("Error fetching campaign details:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Start campaign (send messages)
export const startCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    })
      .populate("sessionId")
      .populate("numberListId");

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    if (campaign.status === "running") {
      return res
        .status(400)
        .json({ success: false, error: "Campaign is already running" });
    }

    // Update status to running
    campaign.status = "running";
    campaign.progress = 0;
    await campaign.save();

    // Start sending messages asynchronously
    sendCampaignMessages(campaign);

    res.json({
      success: true,
      data: campaign,
      message: "Campaign started - messages will be sent",
    });
  } catch (error) {
    console.error("Error starting campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Pause campaign
export const pauseCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    if (campaign.status !== "running") {
      return res.status(400).json({
        success: false,
        error: "Only running campaigns can be paused",
      });
    }

    campaign.status = "paused";
    campaign.pausedAt = new Date();
    await campaign.save();

    res.json({
      success: true,
      data: campaign,
      message: "Campaign paused",
    });
  } catch (error) {
    console.error("Error pausing campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Resume campaign
export const resumeCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    })
      .populate("sessionId")
      .populate("numberListId");

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    if (campaign.status !== "paused") {
      return res.status(400).json({
        success: false,
        error: "Only paused campaigns can be resumed",
      });
    }

    campaign.status = "running";
    campaign.resumedAt = new Date();
    await campaign.save();

    // Resume sending messages
    sendCampaignMessages(campaign);

    res.json({
      success: true,
      data: campaign,
      message: "Campaign resumed",
    });
  } catch (error) {
    console.error("Error resuming campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Retry failed messages
export const retryCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    })
      .populate("sessionId")
      .populate("numberListId");

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    if (campaign.status === "completed") {
      return res.status(400).json({
        success: false,
        error: "Completed campaigns cannot be retried",
      });
    }

    // Mark failed messages for retry
    campaign.messageLog.forEach((log) => {
      if (log.status === "failed") {
        log.status = "pending";
        log.retryCount = (log.retryCount || 0) + 1;
      }
    });

    // Update stats
    campaign.stats.pending = campaign.messageLog.filter(
      (l) => l.status === "pending",
    ).length;
    campaign.stats.failed = 0;
    campaign.status = "running";
    campaign.progress = 0;

    await campaign.save();

    // Resume sending
    sendCampaignMessages(campaign);

    res.json({
      success: true,
      data: campaign,
      message: "Retrying failed messages",
    });
  } catch (error) {
    console.error("Error retrying campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Restart campaign (reset all logs and start fresh)
export const restartCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    }).populate("numberListId");

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    // Reset all message logs to pending
    campaign.messageLog = campaign.messageLog.map((log) => ({
      ...log.toObject(),
      status: "pending",
      retryCount: 0,
      error: undefined,
      timestamp: new Date(),
    }));

    const total = campaign.messageLog.length;
    campaign.stats = {
      total,
      sent: 0,
      delivered: 0,
      failed: 0,
      pending: total,
    };
    campaign.status = "draft";
    campaign.progress = 0;
    campaign.currentIndex = 0;
    campaign.pausedAt = undefined;
    campaign.resumedAt = undefined;
    campaign.completedAt = undefined;
    campaign.failedAt = undefined;

    await campaign.save();

    res.json({ success: true, data: campaign, message: "Campaign restarted" });
  } catch (error) {
    console.error("Error restarting campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete campaign
export const deleteCampaign = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOneAndDelete({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    res.json({
      success: true,
      message: "Campaign deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting campaign:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get campaign report
export const getCampaignReport = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    // Calculate stats from messageLog for accuracy
    const messageLog = campaign.messageLog || [];
    const sentOrDeliveredCount = messageLog.filter(
      (m) => m.status === "sent" || m.status === "delivered",
    ).length;
    const calculatedStats = {
      total: messageLog.length,
      sent: sentOrDeliveredCount,
      delivered: sentOrDeliveredCount,
      failed: messageLog.filter((m) => m.status === "failed").length,
      pending: messageLog.filter((m) => m.status === "pending").length,
    };

    // Fallback to stored stats if messageLog calculation doesn't apply
    const storedStats = campaign.stats || {};
    const effectiveDelivered = calculatedStats.total > 0
      ? calculatedStats.delivered
      : (storedStats.delivered || storedStats.sent || 0);
    const effectiveTotal = calculatedStats.total > 0 ? calculatedStats.total : (storedStats.total || 0);

    const stats = {
      total: effectiveTotal,
      sent: calculatedStats.total > 0 ? calculatedStats.sent : (storedStats.sent || 0),
      delivered: effectiveDelivered,
      failed: calculatedStats.total > 0 ? calculatedStats.failed : (storedStats.failed || 0),
      pending: calculatedStats.total > 0 ? calculatedStats.pending : (storedStats.pending || 0),
    };

    const deliveryRate =
      stats.total > 0 ? ((stats.delivered / stats.total) * 100).toFixed(2) : "0.00";
    const processed = stats.delivered + stats.failed;
    const successRate =
      processed > 0 ? ((stats.delivered / processed) * 100).toFixed(2) : "0.00";

    // Get recent message logs (last 20)
    const recentLogs = messageLog.slice(-20).reverse();

    const report = {
      campaignId: campaign._id,
      name: campaign.name,
      description: campaign.description,
      type: campaign.type,
      status: campaign.status,
      progress: campaign.progress,
      stats: stats,
      deliveryRate: deliveryRate,
      successRate: successRate,
      recentLogs: recentLogs,
      totalLogs: messageLog.length,
      createdAt: campaign.createdAt,
      completedAt: campaign.completedAt,
      duration: campaign.completedAt
        ? new Date(campaign.completedAt) - new Date(campaign.createdAt)
        : new Date() - new Date(campaign.createdAt),
    };

    res.json({ success: true, data: report });
  } catch (error) {
    console.error("Error fetching campaign report:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// ──────────────────────────────────────────────────────────────────
// Internal function: Send campaign messages
// ──────────────────────────────────────────────────────────────────
async function sendCampaignMessages(campaign) {
  try {
    console.log(`\n📢 Starting Campaign: ${campaign.name}`);
    console.log(`📱 Total Recipients: ${campaign.messageLog.length}`);
    console.log(`⏱️  Delay Between Messages: ${campaign.delaySeconds}s\n`);

    // ── Build session pool (multi or single) ──────────────────────────────────
    let sessionPool = []; // [{ id: ObjectId, sessionIdString: "wa_xxx", phone: "..." }]

    if (campaign.multiSession?.enabled && campaign.sessions?.length > 1) {
      const sessionDocs = await WhatsAppSession.find({
        _id: { $in: campaign.sessions },
      });
      sessionPool = sessionDocs
        .filter((s) => s.status === "connected")
        .map((s) => ({
          id: s._id,
          sessionIdString: s.sessionId,
          phone: s.phone || s.sessionId,
        }));
      if (sessionPool.length === 0)
        throw new Error("No connected sessions available in session pool");
      console.log(
        `🔀 Multi-Session Mode: ${campaign.multiSession.mode} across ${sessionPool.length} sessions`,
      );
      sessionPool.forEach((s, idx) =>
        console.log(`   [${idx + 1}] ${s.phone} (${s.sessionIdString})`),
      );
    } else {
      const session = await WhatsAppSession.findById(campaign.sessionId);
      if (!session) throw new Error("WhatsApp session not found");
      sessionPool = [
        {
          id: session._id,
          sessionIdString: session.sessionId,
          phone: session.phone || session.sessionId,
        },
      ];
    }

    // Returns which session pool entry to use for message at global index i
    const getSession = (i, totalPending) => {
      if (sessionPool.length === 1) return sessionPool[0];
      if (campaign.multiSession?.mode === "round-robin") {
        return sessionPool[i % sessionPool.length];
      }
      // Equal split: divide total messages evenly across sessions
      const chunkSize = Math.ceil(totalPending / sessionPool.length);
      const idx = Math.min(Math.floor(i / chunkSize), sessionPool.length - 1);
      return sessionPool[idx];
    };

    const pendingMessages = campaign.messageLog.filter(
      (log) => log.status === "pending",
    );
    let successCount = 0;
    let failureCount = 0;

    // Build contact data lookup map from the number list (digits-last-10 → row)
    const contactMap = {};
    try {
      const numberList = await NumberList.findById(
        campaign.numberListId,
      ).lean();
      if (numberList?.contactData?.length && numberList?.variables?.length) {
        const phoneKeywords = [
          "phone",
          "number",
          "mobile",
          "contact",
          "no",
          "num",
          "tel",
          "whatsapp",
        ];
        const numCol =
          numberList.variables.find((v) =>
            phoneKeywords.some((kw) => v.toLowerCase().includes(kw)),
          ) || numberList.variables[0];
        numberList.contactData.forEach((row) => {
          const raw = String(row[numCol] || "");
          const digits = raw.replace(/\D/g, "");
          if (digits.length >= 10) {
            contactMap[digits.slice(-10)] = row;
          }
        });
      }
    } catch (_) {
      /* non-fatal */
    }

    for (let i = 0; i < pendingMessages.length; i++) {
      const messageLog = pendingMessages[i];

      try {
        // Check if campaign was paused without reading the entire document
        const statusDoc = await Campaign.findById(campaign._id).select("status").lean();
        if (!statusDoc || statusDoc.status === "paused") {
          console.log(`[Campaign ${campaign._id}] Campaign paused or removed. Stopping send loop.`);
          break;
        }

        // Replace placeholders in message — support both {{var}} and {var} syntax
        const recipientLast10 = String(messageLog.phoneNumber)
          .replace(/\D/g, "")
          .slice(-10);
        const contactRow = contactMap[recipientLast10] || {};
        
        // Create a case-insensitive proxy for contactRow
        const getVar = (key) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey === "phone" || lowerKey === "number") return messageLog.phoneNumber;
          if (lowerKey === "date") return new Date().toLocaleDateString();
          if (lowerKey === "time") return new Date().toLocaleTimeString();
          if (lowerKey === "name") return contactRow["name"] || contactRow["Name"] || contactRow["NAME"] || "Customer";
          
          // Case-insensitive search in contactRow keys
          const actualKey = Object.keys(contactRow).find(k => k.toLowerCase() === lowerKey);
          return actualKey ? String(contactRow[actualKey]) : null;
        };

        let messageText = campaign.message;
        
        // 1. Replace {{variable}} pattern
        messageText = messageText.replace(/\{\{([\w\s]+)\}\}/g, (match, key) => {
          const val = getVar(key.trim());
          return val !== null ? val : match;
        });

        // 2. Replace {variable} pattern
        messageText = messageText.replace(/\{([\w\s]+)\}/g, (match, key) => {
          const val = getVar(key.trim());
          return val !== null ? val : match;
        });

        const activeSession = getSession(i, pendingMessages.length);
        const sessionIdString = activeSession.sessionIdString;
        console.log(
          `[${i + 1}/${pendingMessages.length}] 📤 Sending to +${messageLog.phoneNumber} via ${activeSession.phone}...`,
        );

        // Build media list: prefer new mediaFiles array, fall back to legacy single field
        const mimeMap = {
          image: "image/jpeg",
          video: "video/mp4",
          audio: "audio/mpeg",
          pdf: "application/pdf",
          document: "application/octet-stream",
        };

        const resolveMediaItem = (m) => {
          if (!m?.url) return null;
          if (m.url.startsWith("/uploads/")) {
            const diskPath = path.join(
              UPLOADS_DIR,
              m.url.replace("/uploads/", ""),
            );
            if (fs.existsSync(diskPath))
              return { path: diskPath, mime: mimeMap[m.type] || "image/jpeg" };
          }
          return null;
        };

        const mediaList =
          campaign.mediaFiles?.length > 0
            ? campaign.mediaFiles
            : campaign.mediaUrl
              ? [
                  {
                    url: campaign.mediaUrl,
                    type: campaign.mediaType,
                    name: campaign.mediaName,
                  },
                ]
              : [];

        const totalMessages = Math.max(mediaList.length, 1);
        await SubscriptionService.assertMessageQuota(
          { _id: campaign.userId },
          totalMessages,
        );

        if (mediaList.length === 0) {
          // Text-only message
          await WhatsAppService.sendMessage(
            sessionIdString,
            messageLog.phoneNumber,
            messageText,
            null,
            null,
          );
        } else {
          // First media carries the text
          const firstResolved = resolveMediaItem(mediaList[0]);
          await WhatsAppService.sendMessage(
            sessionIdString,
            messageLog.phoneNumber,
            messageText,
            firstResolved?.path || null,
            firstResolved?.mime || null,
          );
          // Remaining media sent as separate messages
          for (let mi = 1; mi < mediaList.length; mi++) {
            const resolved = resolveMediaItem(mediaList[mi]);
            if (resolved) {
              await WhatsAppService.sendMessage(
                sessionIdString,
                messageLog.phoneNumber,
                "",
                resolved.path,
                resolved.mime,
              );
            }
          }
        }

        await SubscriptionService.consumeMessageQuota(
          campaign.userId,
          totalMessages,
        );

        // Update message log to sent and update stats atomically
        await Campaign.updateOne(
          { _id: campaign._id, "messageLog.phoneNumber": messageLog.phoneNumber },
          {
            $set: {
              "messageLog.$.status": "sent",
              "messageLog.$.timestamp": new Date(),
              "messageLog.$.sentBy": activeSession.id
            },
            $inc: {
              "stats.sent": 1,
              "stats.delivered": 1,
              "stats.pending": -1
            }
          }
        );

        successCount++;
        console.log(
          `✅ Message sent to +${messageLog.phoneNumber} via ${activeSession.phone}`,
        );
      } catch (error) {
        console.error(
          `❌ Failed to send to +${messageLog.phoneNumber}: ${error.message}`,
        );

        await Campaign.updateOne(
          { _id: campaign._id, "messageLog.phoneNumber": messageLog.phoneNumber },
          {
            $set: {
              "messageLog.$.status": "failed",
              "messageLog.$.error": error.message
            },
            $inc: {
              "stats.failed": 1,
              "stats.pending": -1
            }
          }
        );

        failureCount++;

        if (
          error?.code === "LIMIT_EXCEEDED" ||
          error?.name === "LimitError"
        ) {
          await Campaign.updateOne(
            { _id: campaign._id },
            { $set: { status: "failed", failedAt: new Date() } }
          );
          console.log(
            "⛔ Campaign stopped due to subscription message limits",
          );
          break;
        }
      }

      // Update overall progress percentage atomically
      const currentProcessed = successCount + failureCount;
      const progressPct = Math.min(100, Math.round((currentProcessed / pendingMessages.length) * 100));

      await Campaign.updateOne(
        { _id: campaign._id },
        {
          $set: {
            progress: progressPct,
            currentIndex: i + 1,
          },
        },
      );

      if (WhatsAppService.io && campaign.userId) {
        WhatsAppService.io.to(`user:${campaign.userId}`).emit("campaign:update", {
          campaignId: String(campaign._id),
          progress: progressPct,
          currentIndex: i + 1,
          stats: {
            sent: successCount,
            failed: failureCount,
            pending: Math.max(0, pendingMessages.length - currentProcessed),
            total: pendingMessages.length,
          },
        });
      }

      // Calculate delay between messages
      let delayMs = 0;
      if (campaign.mode === "instant") {
        // Safety random 5-10s delay even for instant mode to avoid spam detection
        delayMs = (Math.floor(Math.random() * 6) + 5) * 1000;
      } else if (campaign.randomizeDelay) {
        const min = Math.max(campaign.minDelay || 10, 1);
        const max = Math.max(campaign.maxDelay || 30, min);
        const secs = Math.floor(Math.random() * (max - min + 1)) + min;
        delayMs = secs * 1000;
      } else {
        delayMs = Math.max(campaign.delaySeconds || 10, 1) * 1000;
      }

      // Apply delay only between messages (not after last one)
      if (delayMs > 0 && i < pendingMessages.length - 1) {
        const delaySec = (delayMs / 1000).toFixed(1);
        console.log(`⏳ Waiting ${delaySec}s before next message...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    // Auto-retry failed messages once if enabled
    if (campaign.autoRetry && failureCount > 0) {
      console.log(`\n🔄 Auto-retrying ${failureCount} failed messages…`);
      const retryList = await Campaign.findById(campaign._id);
      if (retryList && retryList.status === "running") {
        const failedLogs = retryList.messageLog.filter(
          (l) => l.status === "failed",
        );
        for (const log of failedLogs) {
          try {
            // Use the session that originally sent (if tracked), otherwise primary
            const retrySessionId = log.sentBy || campaign.sessionId;
            const retrySession =
              (await WhatsAppSession.findById(retrySessionId)) ||
              (await WhatsAppSession.findById(campaign.sessionId));
            await SubscriptionService.assertMessageQuota(
              { _id: campaign.userId },
              1,
            );
            await WhatsAppService.sendMessage(
              retrySession.sessionId,
              log.phoneNumber,
              campaign.message,
            );
            await SubscriptionService.consumeMessageQuota(campaign.userId, 1);
            log.status = "sent";
            log.retryCount = (log.retryCount || 0) + 1;
            retryList.stats.sent += 1;
            retryList.stats.failed -= 1;
            successCount++;
            failureCount--;
            console.log(`✅ Retry OK: +${log.phoneNumber}`);
          } catch (err) {
            console.log(
              `❌ Retry failed: +${log.phoneNumber} — ${err.message}`,
            );
          }
          await new Promise((r) => setTimeout(r, 5000)); // 5s between retries
        }
        await retryList.save();
      }
    }

    // Mark campaign as completed
    const finalCampaign = await Campaign.findById(campaign._id);
    if (finalCampaign.status === "running") {
      finalCampaign.status = "completed";
      finalCampaign.progress = 100;
      finalCampaign.completedAt = new Date();
      await finalCampaign.save();

      console.log(`\n✅ Campaign "${finalCampaign.name}" Completed!`);
      console.log(`   ✓ Sent: ${successCount}`);
      console.log(`   ✗ Failed: ${failureCount}\n`);

      if (WhatsAppService.io && finalCampaign.userId) {
        WhatsAppService.io.to(`user:${finalCampaign.userId}`).emit("campaign:completed", {
          campaignId: String(finalCampaign._id),
          status: "completed",
          progress: 100,
          completedAt: finalCampaign.completedAt,
          stats: finalCampaign.stats,
        });
      }

      // Handle repeat scheduling: reset and re-queue for next run
      if (finalCampaign.repeat?.enabled) {
        const nextRun = computeNextRunAt(finalCampaign.repeat);
        if (nextRun) {
          try {
            const nl = await NumberList.findById(finalCampaign.numberListId);
            const phones =
              nl?.numbers || finalCampaign.messageLog.map((l) => l.phoneNumber);
            await Campaign.findByIdAndUpdate(finalCampaign._id, {
              status: "scheduled",
              scheduledFor: nextRun,
              nextRunAt: nextRun,
              progress: 0,
              currentIndex: 0,
              completedAt: null,
              stats: {
                total: phones.length,
                sent: 0,
                delivered: 0,
                failed: 0,
                pending: phones.length,
              },
              messageLog: phones.map((p) => ({
                phoneNumber: p,
                status: "pending",
                retryCount: 0,
              })),
            });
            console.log(
              `🔁 Campaign "${finalCampaign.name}" scheduled for next run: ${nextRun.toLocaleString()}`,
            );
          } catch (repeatErr) {
            console.error("Error scheduling repeat run:", repeatErr.message);
          }
        }
      }
    }
  } catch (error) {
    console.error("❌ Critical Error in sendCampaignMessages:", error);

    try {
      const finalCampaign = await Campaign.findById(campaign._id);
      if (finalCampaign) {
        finalCampaign.status = "failed";
        finalCampaign.failedAt = new Date();
        await finalCampaign.save();
      }
    } catch (updateError) {
      console.error("Error updating campaign status:", updateError);
    }
  }
}

// Compute the next Date a repeat campaign should run
function computeNextRunAt(repeat) {
  if (!repeat?.enabled) return null;
  const now = new Date();
  const [hh, mm] = (repeat.time || "09:00").split(":").map(Number);

  if (repeat.type === "daily") {
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  if (repeat.type === "weekly") {
    const days = repeat.days?.length > 0 ? repeat.days : [1]; // default Monday
    for (let d = 1; d <= 8; d++) {
      const candidate = new Date(now);
      candidate.setDate(now.getDate() + d);
      candidate.setHours(hh, mm, 0, 0);
      if (days.includes(candidate.getDay())) return candidate;
    }
  }

  if (repeat.type === "monthly") {
    const dayOfMonth = repeat.days?.[0] || 1;
    const next = new Date(now);
    next.setDate(dayOfMonth);
    next.setHours(hh, mm, 0, 0);
    if (next <= now) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(dayOfMonth);
    }
    return next;
  }

  return null;
}

// Update campaign schedule / repeat / delay settings
export const updateCampaignSchedule = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      mode,
      scheduledFor,
      repeat,
      minDelay,
      maxDelay,
      randomizeDelay,
      delaySeconds,
    } = req.body;
    const userId = req.user.id;

    const update = { updatedAt: new Date() };
    if (mode !== undefined)
      update.mode = mode === "delayed" ? "interval" : mode;
    if (scheduledFor !== undefined)
      update.scheduledFor = scheduledFor ? new Date(scheduledFor) : null;
    if (repeat !== undefined)
      update.repeat = {
        enabled: !!repeat.enabled,
        type: repeat.type || "daily",
        time: repeat.time || "09:00",
        days: Array.isArray(repeat.days) ? repeat.days : [],
      };
    if (minDelay !== undefined) update.minDelay = Number(minDelay);
    if (maxDelay !== undefined) update.maxDelay = Number(maxDelay);
    if (randomizeDelay !== undefined) update.randomizeDelay = !!randomizeDelay;
    if (delaySeconds !== undefined) update.delaySeconds = Number(delaySeconds);

    // If switching to scheduled mode with a future date, mark as scheduled
    if (
      update.mode === "scheduled" &&
      update.scheduledFor &&
      update.scheduledFor > new Date()
    ) {
      update.status = "scheduled";
    }

    const campaign = await Campaign.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(id),
        userId: new mongoose.Types.ObjectId(userId),
      },
      update,
      { new: true },
    );

    if (!campaign)
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });

    res.json({ success: true, data: campaign });
  } catch (error) {
    console.error("Error updating campaign schedule:", error);
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update the primary session used by a campaign.
export const updateCampaignSession = async (req, res) => {
  try {
    const { id } = req.params;
    const { sessionId } = req.body;
    const userId = req.user.id;

    if (!sessionId) {
      return res
        .status(400)
        .json({ success: false, error: "Missing sessionId" });
    }

    const campaign = await Campaign.findOne({
      _id: new mongoose.Types.ObjectId(id),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!campaign) {
      return res
        .status(404)
        .json({ success: false, error: "Campaign not found" });
    }

    if (campaign.status === "running") {
      return res.status(400).json({
        success: false,
        error: "Pause the campaign before changing its session",
      });
    }

    const session = await WhatsAppSession.findOne({
      _id: new mongoose.Types.ObjectId(sessionId),
      userId: new mongoose.Types.ObjectId(userId),
    });

    if (!session) {
      return res
        .status(404)
        .json({ success: false, error: "WhatsApp session not found" });
    }

    if (session.status !== "connected") {
      return res
        .status(400)
        .json({ success: false, error: "WhatsApp session is not connected" });
    }

    const currentSessionIds = Array.isArray(campaign.sessions)
      ? campaign.sessions.map((sid) => String(sid))
      : [];
    const nextSessionIds = [
      String(session._id),
      ...currentSessionIds.filter((sid) => sid !== String(session._id)),
    ];

    const update = {
      sessionId: session._id,
      sessions: nextSessionIds.map((sid) => new mongoose.Types.ObjectId(sid)),
      updatedAt: new Date(),
    };

    if (campaign.multiSession) {
      const currentMultiSession = campaign.multiSession.toObject
        ? campaign.multiSession.toObject()
        : { ...campaign.multiSession };
      update.multiSession = {
        ...currentMultiSession,
        enabled: !!(currentMultiSession.enabled && nextSessionIds.length > 1),
        mode:
          currentMultiSession.mode === "round-robin" ? "round-robin" : "split",
      };
    }

    const updatedCampaign = await Campaign.findOneAndUpdate(
      {
        _id: new mongoose.Types.ObjectId(id),
        userId: new mongoose.Types.ObjectId(userId),
      },
      update,
      { new: true },
    );

    return res.json({
      success: true,
      data: updatedCampaign,
      message: "Campaign session updated successfully",
    });
  } catch (error) {
    console.error("Error updating campaign session:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Called by the scheduler in server.js
export const startCampaignById = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId)
    .populate("sessionId")
    .populate("numberListId");
  if (!campaign || campaign.status !== "scheduled") return;
  campaign.status = "running";
  campaign.progress = 0;
  await campaign.save();
  console.log(
    `⏰ [SCHEDULER] Auto-starting scheduled campaign: ${campaign.name}`,
  );
  sendCampaignMessages(campaign);
};

export default {
  uploadCampaignMedia,
  createCampaign,
  getCampaigns,
  getCampaignDetails,
  startCampaign,
  pauseCampaign,
  resumeCampaign,
  retryCampaign,
  restartCampaign,
  deleteCampaign,
  getCampaignReport,
  updateCampaignSchedule,
  updateCampaignSession,
};
