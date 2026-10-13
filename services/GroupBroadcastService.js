import WhatsAppService from "./WhatsAppService.js";
import { readFileSync, existsSync } from "fs";
import { extname, join, dirname } from "path";
import { fileURLToPath } from "url";
import GroupBroadcast from "../models/GroupBroadcast.js";
import WaChatMessage from "../models/WaChatMessage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const uploadsDir = join(__dirname, "..", "uploads");

// In-memory store of active repeating intervals keyed by Mongoose ObjectId string
const activeJobs = new Map();

/**
 * Detect MIME type from file extension
 */
function getMimeType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".pdf": "application/pdf",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * Classify the media type for Baileys
 */
function getMediaCategory(mimeType) {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

/**
 * Send a message (text + optional media) to a list of group JIDs
 */
export async function sendToGroups(
  userId,
  sessionId,
  groupJids,
  message,
  mediaPath = null,
  minDelayMs = 3000,
  maxDelayMs = 8000,
  campaignId = null,
  replyToLast = false,
  targetGroups = [],
  existingResults = []
) {
  console.log(`[GroupBroadcast] sendToGroups called for session: ${sessionId}, campaign: ${campaignId}, replyToLast: ${replyToLast}`);

  const sock = WhatsAppService.sockets.get(sessionId);
  if (!sock) throw new Error(`WhatsApp session "${sessionId}" is not active or connected.`);

  const targetGroupsMap = new Map();
  if (Array.isArray(targetGroups)) {
    targetGroups.forEach(tg => {
      if (tg && tg.jid) targetGroupsMap.set(tg.jid, tg);
    });
  }

  // Preserve any previously sent groups when resuming
  const results = Array.isArray(existingResults) ? [...existingResults] : [];

  for (let idx = 0; idx < groupJids.length; idx++) {
    const jid = groupJids[idx];

    // Check if campaign was paused mid-execution
    if (campaignId) {
      const liveCheck = await GroupBroadcast.findById(campaignId).select("status");
      if (liveCheck && liveCheck.status === "paused") {
        console.log(`[GroupBroadcast] Campaign ${campaignId} paused by user. Halting group send loop.`);
        break;
      }
    }

    let groupName = "Unknown Group";
    let memberCount = 0;

    // Fallback to targetGroups mapping if available
    if (targetGroupsMap.has(jid)) {
      const tg = targetGroupsMap.get(jid);
      if (tg.groupName) groupName = tg.groupName;
      if (tg.memberCount) memberCount = tg.memberCount;
    }

    // Attempt to fetch fresh metadata from Baileys socket
    try {
      const metadata = await sock.groupMetadata(jid);
      if (metadata) {
        if (metadata.subject) groupName = metadata.subject;
        if (metadata.participants && Array.isArray(metadata.participants)) {
          memberCount = metadata.participants.length;
        }
      }
    } catch (metaErr) {
      console.warn(`[GroupBroadcast] Could not fetch live metadata for ${jid}: ${metaErr.message}`);
    }

    // Broadcast LIVE "SENDING" status BEFORE socket transmission
    if (WhatsAppService.io && campaignId) {
      const preSentCount = results.filter(r => r.status === "sent").length;
      const preFailedCount = results.filter(r => r.status === "failed").length;
      const preSentMembers = results.filter(r => r.status === "sent").reduce((s, r) => s + (r.memberCount || 0), 0);
      const preFailedMembers = results.filter(r => r.status === "failed").reduce((s, r) => s + (r.memberCount || 0), 0);
      const preTotalMembers = targetGroups.reduce((s, g) => s + (g.memberCount || 0), 0) || memberCount;

      const progressEvent = {
        campaignId,
        status: "running",
        currentSending: {
          jid,
          groupName,
          memberCount,
          index: idx + 1,
          total: groupJids.length,
          status: "sending"
        },
        stats: {
          total: groupJids.length,
          sent: preSentCount,
          failed: preFailedCount,
          totalMembers: preTotalMembers,
          sentMembers: preSentMembers,
          failedMembers: preFailedMembers
        },
        results
      };

      WhatsAppService.io.to(`user:${userId}`).emit("campaign:progress", progressEvent);
      WhatsAppService.io.emit("campaign:progress", progressEvent);
      WhatsAppService.io.emit("group-broadcast:progress", progressEvent);
    }

    // Transmit to the WhatsApp group
    try {
      // Determine if quoting the last message
      let quotedMessage = undefined;
      if (replyToLast) {
        try {
          const lastMsg = await WaChatMessage.findOne({ sessionId, chatJid: jid })
            .sort({ timestamp: -1 })
            .lean();

          if (lastMsg) {
            quotedMessage = {
              key: {
                remoteJid: jid,
                fromMe: lastMsg.direction === "out",
                id: lastMsg.messageId,
              },
              message: {
                conversation: lastMsg.text || ""
              }
            };
            if (lastMsg.participantJid && lastMsg.direction !== "out") {
              quotedMessage.key.participant = lastMsg.participantJid;
            }
          }
        } catch (dbErr) {
          console.error(`[GroupBroadcast] Failed to retrieve last message for ${jid}:`, dbErr.message);
        }
      }

      if (mediaPath) {
        if (!existsSync(mediaPath)) {
          throw new Error(`Media file not found at path: ${mediaPath}`);
        }
        const mime = getMimeType(mediaPath);
        const category = getMediaCategory(mime);
        const fileBuffer = readFileSync(mediaPath);
        const fileName = mediaPath.split(/[\\/]/).pop();

        const msgPayload = {
          [category]: fileBuffer,
          mimetype: mime,
          fileName,
          caption: message || undefined,
        };

        await sock.sendMessage(jid, msgPayload, { quoted: quotedMessage });
      } else if (message?.trim()) {
        await sock.sendMessage(jid, { text: message }, { quoted: quotedMessage });
      }

      const existingIdx = results.findIndex(r => r.jid === jid);
      const resItem = { jid, groupName, memberCount, status: "sent" };
      if (existingIdx >= 0) results[existingIdx] = resItem;
      else results.push(resItem);

      console.log(`[GroupBroadcast] ✅ Sent to group ${groupName} (${jid})`);
    } catch (err) {
      const errorMsg = err?.message || String(err) || "Unknown error";
      const existingIdx = results.findIndex(r => r.jid === jid);
      const resItem = { jid, groupName, memberCount, status: "failed", error: errorMsg };
      if (existingIdx >= 0) results[existingIdx] = resItem;
      else results.push(resItem);

      console.error(`[GroupBroadcast] ❌ Failed to send to ${jid}:`, errorMsg);
    }

    // Compute live cumulative stats
    const sentCount = results.filter(r => r.status === "sent").length;
    const failedCount = results.filter(r => r.status === "failed").length;
    const sentMembers = results.filter(r => r.status === "sent").reduce((s, r) => s + (r.memberCount || 0), 0);
    const failedMembers = results.filter(r => r.status === "failed").reduce((s, r) => s + (r.memberCount || 0), 0);
    const totalMembers = targetGroups.reduce((s, g) => s + (g.memberCount || 0), 0) || results.reduce((s, r) => s + (r.memberCount || 0), 0);

    const statsObj = {
      total: groupJids.length,
      sent: sentCount,
      failed: failedCount,
      totalMembers,
      sentMembers,
      failedMembers
    };

    // Immediately persist live progress to database
    if (campaignId) {
      try {
        await GroupBroadcast.findByIdAndUpdate(campaignId, {
          stats: statsObj,
          results
        });
      } catch (saveErr) {
        console.error(`[GroupBroadcast] Failed to update intermediate progress in DB:`, saveErr.message);
      }
    }

    // Emit live WebSocket update after sending this group
    if (WhatsAppService.io && campaignId) {
      const lastRes = results.find(r => r.jid === jid);
      const progressEvent = {
        campaignId,
        status: "running",
        currentSending: {
          jid,
          groupName,
          memberCount,
          index: idx + 1,
          total: groupJids.length,
          status: lastRes?.status || "sent",
          error: lastRes?.error
        },
        stats: statsObj,
        results
      };

      WhatsAppService.io.to(`user:${userId}`).emit("campaign:progress", progressEvent);
      WhatsAppService.io.emit("campaign:progress", progressEvent);
      WhatsAppService.io.emit("group-broadcast:progress", progressEvent);
    }

    // Check again before sleeping if paused
    if (campaignId) {
      const pausedCheck = await GroupBroadcast.findById(campaignId).select("status");
      if (pausedCheck && pausedCheck.status === "paused") {
        break;
      }
    }

    // Calculate randomized anti-ban delay for this iteration
    const currentDelay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1) + minDelayMs);

    if (currentDelay > 0 && idx < groupJids.length - 1) {
      console.log(`[GroupBroadcast] Anti-ban delay: sleeping ${currentDelay}ms before next group...`);
      await new Promise((r) => setTimeout(r, currentDelay));
    }
  }

  return results;
}

/**
 * Start/Resume a Group Broadcast Campaign
 * @param {string} campaignId - Mongoose ObjectId string of the GroupBroadcast document
 */
export async function startBroadcastCampaign(campaignId) {
  const campaign = await GroupBroadcast.findById(campaignId);
  if (!campaign) throw new Error("Campaign not found");

  // If already running, do nothing
  if (activeJobs.has(campaignId) && campaign.status === "running") {
    return campaign;
  }

  // If restarting a completed or failed campaign, reset stats and results
  if (campaign.status === "completed" || campaign.status === "failed") {
    campaign.stats = {
      total: campaign.groupJids.length,
      sent: 0,
      failed: 0,
      totalMembers: campaign.stats?.totalMembers || 0,
      sentMembers: 0,
      failedMembers: 0
    };
    campaign.results = [];
  }

  campaign.status = "running";
  await campaign.save();

  // Emit immediate WebSocket update so frontend UI transitions to RUNNING immediately
  if (WhatsAppService.io) {
    const startPayload = {
      campaignId,
      status: "running",
      stats: campaign.stats,
      results: campaign.results || [],
      currentSending: null
    };
    WhatsAppService.io.to(`user:${campaign.userId.toString()}`).emit("campaign:update", startPayload);
    WhatsAppService.io.emit("campaign:update", startPayload);
    WhatsAppService.io.emit("group-broadcast:update", startPayload);
  }

  const fireCycle = async () => {
    try {
      const liveCampaign = await GroupBroadcast.findById(campaignId);
      if (!liveCampaign || liveCampaign.status !== "running") {
        clearInterval(activeJobs.get(campaignId));
        clearTimeout(activeJobs.get(campaignId));
        activeJobs.delete(campaignId);
        return;
      }

      // Re-fetch media path if exists
      let mediaPath = null;
      if (liveCampaign.mediaName) {
        mediaPath = join(uploadsDir, liveCampaign.mediaName);
      }

      // For instant mode resuming a paused campaign, send to remaining unsent groups
      let targetJids = liveCampaign.groupJids;
      let initialResults = liveCampaign.results ? [...liveCampaign.results] : [];

      if (liveCampaign.mode === "instant" && initialResults.length > 0) {
        const sentJids = new Set(initialResults.filter(r => r.status === "sent").map(r => r.jid));
        const remaining = liveCampaign.groupJids.filter(jid => !sentJids.has(jid));
        if (remaining.length > 0 && remaining.length < liveCampaign.groupJids.length) {
          targetJids = remaining;
        } else if (remaining.length === 0) {
          initialResults = [];
        }
      }

      const results = await sendToGroups(
        liveCampaign.userId.toString(),
        liveCampaign.sessionId,
        targetJids,
        liveCampaign.message,
        mediaPath,
        liveCampaign.minDelayMs || 3000,
        liveCampaign.maxDelayMs || 8000,
        campaignId,
        liveCampaign.replyToLast || false,
        liveCampaign.targetGroups || [],
        initialResults
      );

      // Check if paused during sending
      const postCheck = await GroupBroadcast.findById(campaignId);
      if (postCheck && postCheck.status === "paused") {
        console.log(`[GroupBroadcast] Campaign ${campaignId} paused by user. Keeping status as paused.`);
        activeJobs.delete(campaignId);
        return;
      }

      const sentCount = results.filter(r => r.status === "sent").length;
      const failedCount = results.filter(r => r.status === "failed").length;
      const sentMembers = results.filter(r => r.status === "sent").reduce((sum, r) => sum + (r.memberCount || 0), 0);
      const failedMembers = results.filter(r => r.status === "failed").reduce((sum, r) => sum + (r.memberCount || 0), 0);
      const totalMembers = results.reduce((sum, r) => sum + (r.memberCount || 0), 0) || liveCampaign.stats?.totalMembers || 0;

      liveCampaign.results = results;
      liveCampaign.stats = {
        total: liveCampaign.groupJids.length,
        sent: sentCount,
        failed: failedCount,
        totalMembers,
        sentMembers,
        failedMembers
      };

      if (liveCampaign.mode === "instant") {
        liveCampaign.status = failedCount === liveCampaign.groupJids.length ? "failed" : "completed";
      }

      await liveCampaign.save();

      // Emit live WebSocket update indicating completion/cycle end
      if (WhatsAppService.io) {
        console.log(`[GroupBroadcast] Emitting live campaign update (${liveCampaign.status})`);
        const updatePayload = {
          campaignId,
          status: liveCampaign.status,
          stats: liveCampaign.stats,
          results: liveCampaign.results,
          currentSending: null
        };
        WhatsAppService.io.to(`user:${liveCampaign.userId.toString()}`).emit("campaign:update", updatePayload);
        WhatsAppService.io.emit("campaign:update", updatePayload);
        WhatsAppService.io.emit("group-broadcast:update", updatePayload);
      }

      // If repeat mode and still running, schedule next cycle
      if (liveCampaign.mode === "repeat" && liveCampaign.status === "running") {
        const timeoutId = setTimeout(fireCycle, liveCampaign.intervalMs);
        activeJobs.set(campaignId, timeoutId);
      } else {
        activeJobs.delete(campaignId);
      }

    } catch (err) {
      console.error(`[GroupBroadcast Service] Run Error for campaign ${campaignId}:`, err.message);

      const liveCampaign = await GroupBroadcast.findById(campaignId);
      if (liveCampaign) {
        liveCampaign.status = "failed";
        liveCampaign.results = [{ jid: "all", status: "failed", error: err.message }];
        const totalMembers = liveCampaign.targetGroups?.reduce((s, g) => s + (g.memberCount || 0), 0) || liveCampaign.stats?.totalMembers || 0;
        liveCampaign.stats = {
          total: liveCampaign.groupJids.length,
          sent: 0,
          failed: liveCampaign.groupJids.length,
          totalMembers,
          sentMembers: 0,
          failedMembers: totalMembers
        };
        await liveCampaign.save();

        if (WhatsAppService.io) {
          const failPayload = {
            campaignId,
            status: "failed",
            stats: liveCampaign.stats,
            results: liveCampaign.results,
            currentSending: null
          };
          WhatsAppService.io.to(`user:${liveCampaign.userId.toString()}`).emit("campaign:update", failPayload);
          WhatsAppService.io.emit("campaign:update", failPayload);
          WhatsAppService.io.emit("group-broadcast:update", failPayload);
        }
      }
      activeJobs.delete(campaignId);
    }
  };

  // Run the first cycle immediately
  activeJobs.set(campaignId, "initializing");
  fireCycle();

  return campaign;
}

/**
 * Pause a running Broadcast Campaign (both instant and repeat)
 * @param {string} campaignId
 */
export async function pauseBroadcastCampaign(campaignId) {
  const timeoutId = activeJobs.get(campaignId);
  if (timeoutId && timeoutId !== "initializing") {
    clearTimeout(timeoutId);
  }
  activeJobs.delete(campaignId);

  const campaign = await GroupBroadcast.findById(campaignId);
  if (campaign) {
    campaign.status = "paused";
    await campaign.save();

    // Emit live paused update
    if (WhatsAppService.io) {
      const pausePayload = {
        campaignId,
        status: "paused",
        stats: campaign.stats,
        results: campaign.results,
        currentSending: null
      };
      WhatsAppService.io.to(`user:${campaign.userId.toString()}`).emit("campaign:update", pausePayload);
      WhatsAppService.io.emit("campaign:update", pausePayload);
      WhatsAppService.io.emit("group-broadcast:update", pausePayload);
    }
  }
  return campaign;
}

/**
 * Cancel/Stop/Delete job tracking for a campaign
 * @param {string} campaignId
 */
export function removeCampaignTracking(campaignId) {
  const timeoutId = activeJobs.get(campaignId);
  if (timeoutId && timeoutId !== "initializing") {
    clearTimeout(timeoutId);
    activeJobs.delete(campaignId);
    console.log(`[GroupBroadcast Service] Stopped job timeout for campaign ${campaignId}`);
  } else if (timeoutId === "initializing") {
    activeJobs.delete(campaignId);
  }
}

/**
 * Get all active repeating jobs memory keys
 */
export function getRunningJobKeys() {
  return Array.from(activeJobs.keys());
}
