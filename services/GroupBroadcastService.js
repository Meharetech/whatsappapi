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
  replyToLast = false
) {
  console.log(`[GroupBroadcast] sendToGroups called for session: ${sessionId}, replyToLast: ${replyToLast}`);

  const sock = WhatsAppService.sockets.get(sessionId);
  if (!sock) throw new Error(`Session ${sessionId} is not connected or socket not found.`);

  const results = [];
  let sentCount = 0;
  let failedCount = 0;

  for (const jid of groupJids) {
    let groupName = "Unknown Group";
    
    try {
      // Safely attempt to fetch the group name for reporting
      try {
        const metadata = await sock.groupMetadata(jid);
        if (metadata && metadata.subject) {
          groupName = metadata.subject;
        }
      } catch (metaErr) {
        console.warn(`[GroupBroadcast] Could not fetch metadata for ${jid}`);
      }

      // Determine if we should reply to the last message in this group JID
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
            console.log(`[GroupBroadcast] Quoting last message for group ${jid} (ID: ${lastMsg.messageId})`);
          } else {
            console.log(`[GroupBroadcast] No previous message found in DB for group ${jid} to reply to.`);
          }
        } catch (dbErr) {
          console.error(`[GroupBroadcast] Failed to retrieve last message for JID ${jid}:`, dbErr.message);
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

      results.push({ jid, groupName, status: "sent" });
      sentCount++;
      console.log(`[GroupBroadcast] ✅ Sent to ${jid}`);
    } catch (err) {
      const errorMsg = err?.message || String(err) || "Unknown error (e.g., bot not allowed to send in group)";
      results.push({ jid, groupName, status: "failed", error: errorMsg });
      failedCount++;
      console.error(`[GroupBroadcast] ❌ Failed to send to ${jid}:`, errorMsg);
    }

    // Emit live real-time progress update over WebSockets!
    if (WhatsAppService.io && campaignId) {
      console.log(`[GroupBroadcast] Emitting live campaign progress update to user room user:${userId}`);
      WhatsAppService.io.to(`user:${userId}`).emit("campaign:progress", {
        campaignId,
        stats: {
          total: groupJids.length,
          sent: sentCount,
          failed: failedCount
        },
        results
      });
    }

    // Calculate randomized anti-ban delay for this iteration
    const currentDelay = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1) + minDelayMs);

    // Delay between groups to reduce ban risk (skip on the last group)
    if (currentDelay > 0 && groupJids.indexOf(jid) < groupJids.length - 1) {
      console.log(`[GroupBroadcast] Sleeping for ${currentDelay}ms before next group...`);
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
  if (activeJobs.has(campaignId)) return campaign;

  campaign.status = "running";
  await campaign.save();

  const fireCycle = async () => {
    try {
      const liveCampaign = await GroupBroadcast.findById(campaignId);
      if (!liveCampaign || liveCampaign.status !== "running") {
        // Stop repeat if deleted or paused
        clearInterval(activeJobs.get(campaignId));
        activeJobs.delete(campaignId);
        return;
      }

      // Re-fetch media path if exists (using absolute resolved folder path)
      let mediaPath = null;
      if (liveCampaign.mediaName) {
        mediaPath = join(uploadsDir, liveCampaign.mediaName);
      }

      const results = await sendToGroups(
        liveCampaign.userId.toString(),
        liveCampaign.sessionId,
        liveCampaign.groupJids,
        liveCampaign.message,
        mediaPath,
        liveCampaign.minDelayMs || 3000,
        liveCampaign.maxDelayMs || 8000,
        campaignId,
        liveCampaign.replyToLast || false
      );

      const sentCount = results.filter(r => r.status === "sent").length;
      const failedCount = results.filter(r => r.status === "failed").length;

      liveCampaign.results = results;
      liveCampaign.stats = {
        total: liveCampaign.groupJids.length,
        sent: sentCount,
        failed: failedCount
      };

      if (liveCampaign.mode === "instant") {
        liveCampaign.status = failedCount === liveCampaign.groupJids.length ? "failed" : "completed";
      }

      await liveCampaign.save();

      // Emit live WebSocket update indicating completion/failure
      if (WhatsAppService.io) {
        console.log(`[GroupBroadcast] Emitting live campaign update (completed) to room user:${liveCampaign.userId.toString()}`);
        WhatsAppService.io.to(`user:${liveCampaign.userId.toString()}`).emit("campaign:update", {
          campaignId,
          status: liveCampaign.status,
          stats: liveCampaign.stats,
          results: liveCampaign.results
        });
      }

      // If repeat mode, schedule the next cycle AFTER this one finishes
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
        liveCampaign.stats = {
          total: liveCampaign.groupJids.length,
          sent: 0,
          failed: liveCampaign.groupJids.length
        };
        await liveCampaign.save();

        // Emit failure live update
        if (WhatsAppService.io) {
          WhatsAppService.io.to(`user:${liveCampaign.userId.toString()}`).emit("campaign:update", {
            campaignId,
            status: "failed",
            stats: liveCampaign.stats,
            results: liveCampaign.results
          });
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
 * Pause a running Repeat Broadcast Campaign
 * @param {string} campaignId
 */
export async function pauseBroadcastCampaign(campaignId) {
  const timeoutId = activeJobs.get(campaignId);
  if (timeoutId && timeoutId !== "initializing") {
    clearTimeout(timeoutId);
    activeJobs.delete(campaignId);
  } else if (timeoutId === "initializing") {
    activeJobs.delete(campaignId);
  }

  const campaign = await GroupBroadcast.findById(campaignId);
  if (campaign) {
    campaign.status = "paused";
    await campaign.save();

    // Emit live paused update
    if (WhatsAppService.io) {
      WhatsAppService.io.to(`user:${campaign.userId.toString()}`).emit("campaign:update", {
        campaignId,
        status: "paused",
        stats: campaign.stats,
        results: campaign.results
      });
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
