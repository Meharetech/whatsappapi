import express from "express";
import authMiddleware from "../middleware/auth.js";
import upload from "../utils/fileUpload.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import GroupBroadcast from "../models/GroupBroadcast.js";
import {
  startBroadcastCampaign,
  pauseBroadcastCampaign,
  removeCampaignTracking,
} from "../services/GroupBroadcastService.js";

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * GET /api/group-broadcast/list
 * Returns all group broadcasts for the logged-in user, sorted by date
 */
router.get("/list", authMiddleware, async (req, res) => {
  try {
    const list = await GroupBroadcast.find({ userId: req.user._id }).sort({ createdAt: -1 });
    res.json({ success: true, list });
  } catch (err) {
    console.error("[GroupBroadcast List Route] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/group-broadcast/save
 * Composes a campaign and saves it as a "draft" in the DB.
 * Body (multipart/form-data):
 *   sessionId   — string  (required)
 *   groupJids   — JSON array string of group JIDs  (required)
 *   message     — string  (optional if media attached)
 *   mode        — "instant" | "repeat"  (default: instant)
 *   intervalMs  — number in ms (required when mode=repeat)
 * File: file (optional)
 */
router.post(
  "/save",
  authMiddleware,
  upload.single("file"),
  async (req, res) => {
    try {
      const userId = req.user._id;
      const { sessionId, message, mode = "instant", minDelayMs, maxDelayMs, replyToLast } = req.body;

      let groupJids;
      try {
        groupJids = JSON.parse(req.body.groupJids || "[]");
      } catch {
        return res.status(400).json({ error: "groupJids must be a valid JSON array" });
      }

      let targetGroups = [];
      try {
        if (req.body.targetGroups) {
          targetGroups = typeof req.body.targetGroups === "string" ? JSON.parse(req.body.targetGroups) : req.body.targetGroups;
        }
      } catch (e) {
        console.warn("[GroupBroadcast Save Route] Could not parse targetGroups JSON:", e.message);
      }

      if (!sessionId) return res.status(400).json({ error: "sessionId is required" });
      if (!groupJids?.length) return res.status(400).json({ error: "At least one group must be selected" });
      if (!message?.trim() && !req.file) return res.status(400).json({ error: "Message or media file is required" });

      let mediaUrl = "";
      let mediaName = "";
      if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        mediaName = req.file.filename;
      }

      let intervalMs = null;
      if (mode === "repeat") {
        intervalMs = parseInt(req.body.intervalMs);
        if (!intervalMs || intervalMs < 10000) {
          return res.status(400).json({ error: "intervalMs must be at least 10000 (10 seconds)" });
        }
      }

      const totalMembers = Array.isArray(targetGroups)
        ? targetGroups.reduce((sum, g) => sum + (Number(g.memberCount) || 0), 0)
        : 0;

      const campaign = await GroupBroadcast.create({
        userId,
        sessionId,
        groupJids,
        targetGroups,
        message: message || "",
        mediaUrl,
        mediaName,
        mode,
        intervalMs,
        status: "draft",
        minDelayMs: minDelayMs ? parseInt(minDelayMs) : 3000,
        maxDelayMs: maxDelayMs ? parseInt(maxDelayMs) : 8000,
        replyToLast: replyToLast === "true" || replyToLast === true,
        stats: {
          total: groupJids.length,
          sent: 0,
          failed: 0,
          totalMembers,
          sentMembers: 0,
          failedMembers: 0
        }
      });

      res.status(201).json({ success: true, campaign });
    } catch (err) {
      console.error("[GroupBroadcast Save Route] Error:", err.message);
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * POST /api/group-broadcast/:id/start
 * Launches or resumes a draft/paused campaign
 */
router.post("/:id/start", authMiddleware, async (req, res) => {
  try {
    const campaign = await GroupBroadcast.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const updated = await startBroadcastCampaign(campaign._id.toString());
    res.json({ success: true, campaign: updated });
  } catch (err) {
    console.error("[GroupBroadcast Start Route] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/group-broadcast/:id/pause
 * Pauses a running repeating campaign
 */
router.post("/:id/pause", authMiddleware, async (req, res) => {
  try {
    const campaign = await GroupBroadcast.findOne({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.mode !== "repeat") return res.status(400).json({ error: "Only repeating campaigns can be paused" });

    const updated = await pauseBroadcastCampaign(campaign._id.toString());
    res.json({ success: true, campaign: updated });
  } catch (err) {
    console.error("[GroupBroadcast Pause Route] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/group-broadcast/:id
 * Deletes a campaign from DB and halts interval tracking
 */
router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const campaign = await GroupBroadcast.findOneAndDelete({ _id: req.params.id, userId: req.user._id });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    removeCampaignTracking(campaign._id.toString());
    res.json({ success: true });
  } catch (err) {
    console.error("[GroupBroadcast Delete Route] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
