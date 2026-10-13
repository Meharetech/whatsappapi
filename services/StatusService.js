import { readFileSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";
import WhatsAppService from "./WhatsAppService.js";
import { WaStatus, WaChat, NumberList } from "../models/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATUS_JID = "status@broadcast";

/**
 * Helper to normalize a WhatsApp JID (removes device suffix like :12@s.whatsapp.net)
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return null;
  const clean = jid.replace(/:.*@/, "@").trim();
  if (clean.endsWith("@s.whatsapp.net")) return clean;
  // If it's pure phone number digits
  const digits = clean.replace(/[^0-9]/g, "");
  if (digits.length >= 7 && digits.length <= 15) return `${digits}@s.whatsapp.net`;
  return null;
}

/**
 * Helper to resolve media buffer from local path or remote URL
 */
async function getMediaBuffer(mediaUrl) {
  if (!mediaUrl) return null;

  if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Failed to fetch media from URL: ${mediaUrl} (${res.statusText})`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  const cleanUrl = mediaUrl.startsWith("/") ? mediaUrl.slice(1) : mediaUrl;
  const filename = basename(cleanUrl);

  const candidatePaths = [
    join(__dirname, "../uploads", filename),
    join(process.cwd(), cleanUrl),
    join(process.cwd(), "..", cleanUrl),
    join(process.cwd(), "uploads", filename),
    join(__dirname, "..", cleanUrl),
    join(process.cwd(), "backend", "uploads", filename),
  ];

  for (const p of candidatePaths) {
    if (existsSync(p)) {
      return readFileSync(p);
    }
  }

  return null;
}

class StatusService {
  constructor() {
    this.intervalId = null;
  }

  start() {
    if (this.intervalId) return;
    console.log("[STATUS SERVICE] Started scheduled status worker tick (every 15s)");
    this.intervalId = setInterval(() => this.processScheduledStatuses(), 15 * 1000);
  }

  /**
   * Helper to retrieve status recipient JIDs.
   * WhatsApp status broadcasts must include contacts who are allowed to see the status.
   * We prioritize active 1-on-1 chats for this session and cap the list to avoid USync IQ packet drops.
   */
  async getStatusJidList(userId, sessionId, sock) {
    const jidSet = new Set();

    // 1. Always include own normalized JID
    const rawSelf = sock?.user?.id || sock?.authState?.creds?.me?.id;
    if (rawSelf) {
      const selfJid = normalizeJid(rawSelf);
      if (selfJid) jidSet.add(selfJid);
    }

    try {
      // 2. Load active 1-on-1 chats for THIS session first
      if (sessionId) {
        const sessionChats = await WaChat.find(
          { sessionId, isGroup: false },
          { chatJid: 1, phoneNumber: 1 }
        )
          .sort({ lastMessageTime: -1 })
          .limit(80)
          .lean();

        sessionChats.forEach((c) => {
          if (c.chatJid && !c.chatJid.includes("@g.us") && !c.chatJid.includes("@newsletter")) {
            const clean = normalizeJid(c.chatJid) || (c.phoneNumber ? normalizeJid(c.phoneNumber) : null);
            if (clean) jidSet.add(clean);
          }
        });
      }

      // 3. If session chats are few, supplement with other 1-on-1 chats from this user
      if (jidSet.size < 40 && userId) {
        const userChats = await WaChat.find(
          { userId, isGroup: false },
          { chatJid: 1, phoneNumber: 1 }
        )
          .sort({ lastMessageTime: -1 })
          .limit(60)
          .lean();

        userChats.forEach((c) => {
          if (c.chatJid && !c.chatJid.includes("@g.us") && !c.chatJid.includes("@newsletter")) {
            const clean = normalizeJid(c.chatJid) || (c.phoneNumber ? normalizeJid(c.phoneNumber) : null);
            if (clean) jidSet.add(clean);
          }
        });
      }
    } catch (e) {
      console.error("[STATUS SERVICE] Failed to load contacts for status broadcast list:", e.message);
    }

    // Fallback if no contacts found yet: ensure at least self is in the recipient list
    if (jidSet.size === 0 && rawSelf) {
      const selfJid = normalizeJid(rawSelf);
      if (selfJid) jidSet.add(selfJid);
    }

    // Limit to safe batch (e.g. max 100 contacts) so WhatsApp USync device query never times out
    const result = Array.from(jidSet).slice(0, 100);
    console.log(`[STATUS SERVICE] Resolved ${result.length} status audience recipient(s).`);
    return result;
  }

  /**
   * Dispatches a single status (text, image, or video) directly to WhatsApp via Baileys
   */
  async broadcastStatus({ userId, sessionId, type, text, backgroundColor, mediaBuffer, mediaType, mediaUrl }) {
    const startTime = Date.now();
    const sock = WhatsAppService.sockets.get(sessionId);
    if (!sock?.user?.id && !sock?.authState?.creds?.me?.id) {
      throw new Error("WhatsApp session is not connected.");
    }

    // Resolve media buffer if not provided directly
    if (type === "media" && !mediaBuffer && mediaUrl) {
      mediaBuffer = await getMediaBuffer(mediaUrl);
      if (!mediaBuffer) {
        throw new Error(`Media file could not be loaded: ${mediaUrl}`);
      }
    }

    const statusJidList = await this.getStatusJidList(userId, sessionId, sock);
    const rawSelf = sock?.user?.id || sock?.authState?.creds?.me?.id;
    const selfJid = normalizeJid(rawSelf);

    let payload;
    if (type === "media" && mediaBuffer) {
      const isVideo = (mediaType || "").toLowerCase().includes("video");
      if (isVideo) {
        payload = {
          video: mediaBuffer,
          mimetype: mediaType || "video/mp4",
          caption: text ? text.trim() : undefined,
        };
      } else {
        payload = {
          image: mediaBuffer,
          mimetype: mediaType || "image/jpeg",
          caption: text ? text.trim() : undefined,
        };
      }
    } else {
      // Text status story
      payload = {
        text: text ? text.trim() : "",
      };
    }

    // Baileys broadcast options for WhatsApp Stories
    const sendOptions = {
      statusJidList: statusJidList.length > 0 ? statusJidList : (selfJid ? [selfJid] : []),
      broadcast: true,
      useUserDevicesCache: true,
    };

    if (type !== "media") {
      sendOptions.backgroundColor = backgroundColor || "#008069";
      sendOptions.font = 0;
    }

    console.log(
      `[STATUS SERVICE] Sending WhatsApp Status: type=${type}, session=${sessionId}, recipients=${sendOptions.statusJidList.length}...`
    );

    // 60-second safety timeout
    const sendPromise = sock.sendMessage(STATUS_JID, payload, sendOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("WhatsApp status dispatch timed out (60s). Please check network and session.")),
        60000
      )
    );

    const sent = await Promise.race([sendPromise, timeoutPromise]);
    const durationMs = Date.now() - startTime;
    const waMessageId = sent?.key?.id || "N/A";

    console.log(
      `[STATUS SERVICE] Status successfully dispatched to WhatsApp! ID: ${waMessageId}, duration: ${durationMs}ms`
    );

    return {
      sent,
      waMessageId,
      recipientsCount: sendOptions.statusJidList.length,
      sampleRecipients: sendOptions.statusJidList.slice(0, 5),
      durationMs,
    };
  }

  /**
   * Periodic scheduler tick
   */
  async processScheduledStatuses() {
    try {
      const now = new Date();
      const pendingStatuses = await WaStatus.find({
        status: "scheduled",
        scheduledFor: { $lte: now },
      }).limit(10);

      if (!pendingStatuses || pendingStatuses.length === 0) return;

      for (const item of pendingStatuses) {
        try {
          const result = await this.broadcastStatus({
            userId: item.userId,
            sessionId: item.sessionId,
            type: item.type,
            text: item.text,
            backgroundColor: item.backgroundColor,
            mediaType: item.mediaType,
            mediaUrl: item.mediaUrl,
          });

          item.status = "sent";
          item.postedAt = new Date();
          item.waMessageId = result.waMessageId || "";
          item.recipientsCount = result.recipientsCount || 0;
          item.debugInfo = {
            durationMs: result.durationMs,
            sampleRecipients: result.sampleRecipients,
          };
          item.errorMessage = "";
          await item.save();
          console.log(`[STATUS SERVICE] Successfully posted scheduled status: ${item._id}`);
        } catch (err) {
          console.error(`[STATUS SERVICE] Failed scheduled status ${item._id}:`, err.message);
          item.status = "failed";
          item.errorMessage = err.message || "Failed to post status.";
          item.debugInfo = { error: err.message, failedAt: new Date() };
          await item.save();
        }
      }
    } catch (e) {
      console.error("[STATUS SERVICE ERROR]", e.message);
    }
  }
}

const statusService = new StatusService();
export default statusService;

