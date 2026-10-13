import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import WhatsAppService from "../services/WhatsAppService.js";
import statusService from "../services/StatusService.js";
import { WaStatus } from "../models/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * GET /api/chats/:sessionId/status/history
 * Fetch previous statuses (sent, scheduled, failed)
 */
export const getStatusHistory = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;

    const statuses = await WaStatus.find({ userId, sessionId })
      .sort({ createdAt: -1 })
      .limit(30)
      .lean();

    return res.json({ success: true, data: statuses });
  } catch (err) {
    console.error("[STATUS CONTROLLER] getStatusHistory error:", err);
    return res.status(500).json({ message: err.message || "Failed to load status history." });
  }
};

/**
 * DELETE /api/chats/:sessionId/status/:statusId
 * Delete or cancel a scheduled status
 */
export const deleteStatus = async (req, res) => {
  try {
    const { sessionId, statusId } = req.params;
    const userId = req.user.id;

    await WaStatus.findOneAndDelete({ _id: statusId, userId, sessionId });
    return res.json({ success: true, message: "Status removed successfully." });
  } catch (err) {
    console.error("[STATUS CONTROLLER] deleteStatus error:", err);
    return res.status(500).json({ message: err.message || "Failed to delete status." });
  }
};

/**
 * POST /api/chats/:sessionId/status
 * Post a WhatsApp Status update immediately or schedule for later (text, image, or video).
 * Body (multipart/form-data):
 *   - text            {string} Caption / text for the status
 *   - backgroundColor {string} Hex color for text-only status
 *   - scheduledFor    {ISO string / timestamp} Optional schedule time
 *   - file            {File} Optional media file
 */
export const postStatus = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;
    const { text = "", backgroundColor = "#008069", scheduledFor } = req.body;
    const file = req.file;

    const sock = WhatsAppService.sockets.get(sessionId);
    if (!sock?.user?.id) {
      return res.status(400).json({ message: "WhatsApp session is not connected." });
    }

    const type = file ? "media" : "text";
    let mediaUrl = "";
    let mediaType = "";
    let mediaBuffer = null;

    if (file) {
      mediaType = file.mimetype;
      if (!mediaType.startsWith("image/") && !mediaType.startsWith("video/")) {
        return res.status(400).json({ message: "Only image and video files are supported for status." });
      }
      mediaUrl = `/uploads/${file.filename}`;
      mediaBuffer = readFileSync(file.path);
    } else if (!text.trim()) {
      return res.status(400).json({ message: "Provide either text or a media file for the status." });
    }

    const isScheduled = !!scheduledFor && new Date(scheduledFor) > new Date();

    if (isScheduled) {
      const scheduledDoc = await WaStatus.create({
        userId,
        sessionId,
        type,
        text: text.trim(),
        backgroundColor,
        mediaUrl,
        mediaType,
        status: "scheduled",
        scheduledFor: new Date(scheduledFor),
      });

      return res.json({
        success: true,
        message: "Status scheduled successfully!",
        data: scheduledDoc,
      });
    }

    // Create record with initial status "sending"
    const statusDoc = await WaStatus.create({
      userId,
      sessionId,
      type,
      text: text.trim(),
      backgroundColor,
      mediaUrl,
      mediaType,
      status: "sending",
    });

    try {
      // Broadcast to WhatsApp with live confirmation
      const result = await statusService.broadcastStatus({
        userId,
        sessionId,
        type,
        text: text.trim(),
        backgroundColor,
        mediaBuffer,
        mediaType,
      });

      statusDoc.status = "sent";
      statusDoc.postedAt = new Date();
      statusDoc.waMessageId = result.waMessageId || "";
      statusDoc.recipientsCount = result.recipientsCount || 0;
      statusDoc.debugInfo = {
        durationMs: result.durationMs,
        sampleRecipients: result.sampleRecipients,
      };
      await statusDoc.save();

      return res.json({
        success: true,
        message: `Status posted successfully to ${result.recipientsCount} contact(s)!`,
        data: statusDoc,
      });
    } catch (broadcastErr) {
      console.error("[STATUS CONTROLLER] Error posting status:", broadcastErr);
      statusDoc.status = "failed";
      statusDoc.errorMessage = broadcastErr.message || "Failed to dispatch status to WhatsApp.";
      statusDoc.debugInfo = { error: broadcastErr.message, failedAt: new Date() };
      await statusDoc.save();

      return res.status(500).json({
        success: false,
        message: broadcastErr.message || "Failed to post status.",
        data: statusDoc,
      });
    }
  } catch (err) {
    console.error("[STATUS CONTROLLER] Error posting status:", err);
    return res.status(500).json({ message: err.message || "Failed to post status." });
  }
};


export const postStatusFromMedia = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const userId = req.user.id;
    const { mediaUrl, mediaType, text = "", scheduledFor } = req.body;

    const sock = WhatsAppService.sockets.get(sessionId);
    if (!sock?.user?.id && !sock?.authState?.creds?.me?.id) {
      return res.status(400).json({ message: "WhatsApp session is not connected." });
    }

    if (!mediaUrl || !mediaType) {
      return res.status(400).json({ message: "mediaUrl and mediaType are required." });
    }

    const isScheduled = !!scheduledFor && new Date(scheduledFor) > new Date();

    if (isScheduled) {
      const scheduledDoc = await WaStatus.create({
        userId,
        sessionId,
        type: "media",
        text: text ? text.trim() : "",
        mediaUrl,
        mediaType,
        status: "scheduled",
        scheduledFor: new Date(scheduledFor),
      });

      return res.json({
        success: true,
        message: "Media status scheduled successfully!",
        data: scheduledDoc,
      });
    }

    // Create record with initial status "sending"
    const statusDoc = await WaStatus.create({
      userId,
      sessionId,
      type: "media",
      text: text ? text.trim() : "",
      backgroundColor: "#008069",
      mediaUrl,
      mediaType,
      status: "sending",
    });

    try {
      // Broadcast to WhatsApp via statusService
      const result = await statusService.broadcastStatus({
        userId,
        sessionId,
        type: "media",
        text: text ? text.trim() : "",
        backgroundColor: "#008069",
        mediaType,
        mediaUrl,
      });

      statusDoc.status = "sent";
      statusDoc.postedAt = new Date();
      statusDoc.waMessageId = result.waMessageId || "";
      statusDoc.recipientsCount = result.recipientsCount || 0;
      statusDoc.debugInfo = {
        durationMs: result.durationMs,
        sampleRecipients: result.sampleRecipients,
      };
      await statusDoc.save();

      return res.json({
        success: true,
        message: `Media status posted successfully to ${result.recipientsCount} contact(s)!`,
        data: statusDoc,
      });
    } catch (broadcastErr) {
      console.error("[STATUS CONTROLLER] Broadcast media error:", broadcastErr);
      statusDoc.status = "failed";
      statusDoc.errorMessage = broadcastErr.message || "Failed to dispatch media status.";
      statusDoc.debugInfo = { error: broadcastErr.message, failedAt: new Date() };
      await statusDoc.save();

      return res.status(500).json({
        success: false,
        message: broadcastErr.message || "Failed to post status from media gallery.",
        data: statusDoc,
      });
    }
  } catch (err) {
    console.error("[STATUS CONTROLLER] Error posting status from media:", err);
    return res.status(500).json({ message: err.message || "Failed to post status." });
  }
};
