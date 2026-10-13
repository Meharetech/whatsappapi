import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  downloadMediaMessage,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import NodeCache from "node-cache";
import { useMongoAuthState } from "../utils/mongoAuthState.js";
import { Boom } from "@hapi/boom";
import mongoose from "mongoose";
import * as qrcode from "qrcode";
import {
  writeFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  readFileSync,
  statSync,
} from "fs";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import {
  WhatsAppSession as SessionModel,
  Message,
  WaChat,
  WaChatMessage,
  WhatsAppAuthState,
  CrmContact,
  WhatsAppGroup,
} from "../models/index.js";
import groupSyncService from "./GroupSyncService.js";
import chatSyncService from "./ChatSyncService.js";
import { handleIncomingMessage } from "./AiAgentService.js";
import { executeFlowOnMessage } from "../controllers/flowExecutionController.js";
import dripService from "./DripService.js";
import { isMetaAiJid, META_AI_NORMALIZED_JID, resolveMetaAiBot } from "./MetaAiService.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SESSIONS_DIR =
  process.env.SESSIONS_DIR ||
  (existsSync(join(__dirname, "..", "..", "wa-sessions"))
    ? join(__dirname, "..", "..", "wa-sessions")
    : join(__dirname, "..", "wa-sessions"));

if (!existsSync(SESSIONS_DIR)) {
  try {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  } catch (_) {}
}

/**
 * WhatsApp Service with reconnect storm prevention
 *
 * Features implemented to prevent reconnect loops:
 * 1. Reconnect Cooldown: 15-second minimum between reconnects per session
 * 2. Retry Limit: Maximum 5 reconnect attempts before pausing
 * 3. 515 Error Handling: 5-second delayed restart for stream errors (was 2s)
 * 4. Single Socket Enforcement: Prevents duplicate socket creation per session
 * 5. Active Socket Tracking: Uses activeSockets Set to track live connections
 * 6. Exponential Backoff: Gradual increase in reconnect delays (base * 1.5^attempts)
 * 7. Proper Cleanup: removeSocket() method cleans up all tracking maps/sets
 *
 * These features eliminate the "reconnect storm" where 515 errors cause
 * immediate reconnection attempts, creating instability loops.
 */
/**
 * Concurrently resolves WhatsApp LID-based identifiers to legacy phone-number-based JIDs (PNs)
 * in cooperative micro-batches so the Node.js event loop is never blocked.
 */
async function resolveGroupParticipantsLids(sock, participants) {
  if (!participants || !Array.isArray(participants) || !sock) return;

  // Extract unique LIDs that do not already have phone numbers resolved
  const lidsToResolve = [...new Set(
    participants
      .filter(p => p.id && p.id.endsWith('@lid') && !p.phoneNumber)
      .map(p => p.id)
  )];

  if (lidsToResolve.length === 0) return;

  const resolvedMappings = {};
  const BATCH_SIZE = 25;

  for (let i = 0; i < lidsToResolve.length; i += BATCH_SIZE) {
    const chunk = lidsToResolve.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map(async (lid) => {
        try {
          const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID(lid);
          if (pnJid) {
            resolvedMappings[lid] = pnJid;
          }
        } catch (err) {
          // Ignore individual LID mapping misses
        }
      })
    );
    // Yield to the Node.js event loop between batches so WebSocket pings/pongs are never delayed
    if (i + BATCH_SIZE < lidsToResolve.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  for (const p of participants) {
    if (p.id && resolvedMappings[p.id]) {
      p.phoneNumber = resolvedMappings[p.id];
    }
  }
}

async function waitForSocketOpenWithTimeout(sock, timeoutMs = 8000) {
  if (!sock) {
    throw new Error("Socket connection not found.");
  }
  const ws = sock.ws;
  const isOpen = ws ? (ws.isOpen ?? (ws.readyState === 1 || ws.socket?.readyState === 1)) : false;
  if (isOpen) {
    return;
  }
  if (typeof sock.waitForSocketOpen !== "function") {
    return;
  }
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("Timeout waiting for WhatsApp connection. Please verify your phone is connected and active."));
    }, timeoutMs);
  });
  try {
    await Promise.race([
      sock.waitForSocketOpen(),
      timeoutPromise
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

class WhatsAppService {
  constructor() {
    this.sockets = new Map();
    this.io = null;
    this.pendingQRCodes = new Map();
    this.reconnectAttempts = new Map();
    this.pendingReconnects = new Set();
    this.heartbeats = new Map();
    this.reconnectCooldown = new Map(); // Tracks last reconnect time per session
    this.activeSockets = new Set(); // Tracks currently active socket connections
    this.taskQueues = new Map(); // Per-session serialized execution queue
    this.messageCache = new Map(); // Recent message proto cache for getMessage (bounded size 1000)
    
    // High-performance group metadata cache (5 minutes TTL, useClones: false to eliminate memory/CPU overhead)
    this.groupCache = new NodeCache({
      stdTTL: 5 * 60, // 300 seconds (5 minutes)
      useClones: false,
    });

    this.isRestoring = false; // Prevents concurrent boot restore collisions

    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
    this.startAutoReconnectWatchdog();
  }

  /**
   * Enqueues an async task (e.g. sending message) on a specific session's socket.
   * Ensures tasks execute sequentially with adaptive micro-delay to prevent socket 515/428 stream errors.
   */
  async enqueueSessionTask(sessionId, taskFn, minDelayMs = 150) {
    const prevPromise = this.taskQueues.get(sessionId) || Promise.resolve();

    let taskResultPromise;
    const nextPromise = prevPromise
      .catch(() => {}) // Don't let previous failures break subsequent tasks
      .then(async () => {
        const result = await taskFn();
        if (minDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, minDelayMs));
        }
        return result;
      });

    this.taskQueues.set(sessionId, nextPromise);

    // Clean up queue entry when done
    nextPromise.finally(() => {
      if (this.taskQueues.get(sessionId) === nextPromise) {
        this.taskQueues.delete(sessionId);
      }
    });

    return nextPromise;
  }

  setSocketIO(io) {
    this.io = io;
  }

  clearHeartbeat(sessionId) {
    const t = this.heartbeats.get(sessionId);
    if (t) clearInterval(t);
    this.heartbeats.delete(sessionId);
  }

  setCachedMessage(messageId, msgProto) {
    if (!messageId || !msgProto) return;
    if (this.messageCache.size >= 1000) {
      const firstKey = this.messageCache.keys().next().value;
      if (firstKey) this.messageCache.delete(firstKey);
    }
    this.messageCache.set(messageId, msgProto);
  }

  getCachedMessage(messageId) {
    if (!messageId) return null;
    return this.messageCache.get(messageId) || null;
  }

  getGroupMetadataFromCache(sessionId, jid) {
    if (!jid) return null;
    return this.groupCache.get(`${sessionId}:${jid}`) || this.groupCache.get(jid) || null;
  }

  setGroupMetadataInCache(sessionId, jid, metadata, ttlSeconds = 300) {
    if (!jid || !metadata) return;
    this.groupCache.set(`${sessionId}:${jid}`, metadata, ttlSeconds);
    this.groupCache.set(jid, metadata, ttlSeconds);
  }

  invalidateGroupMetadataCache(sessionId, jid) {
    if (jid) {
      this.groupCache.del(`${sessionId}:${jid}`);
      this.groupCache.del(jid);
    } else if (sessionId) {
      const keys = this.groupCache.keys();
      for (const k of keys) {
        if (k.startsWith(`${sessionId}:`)) {
          this.groupCache.del(k);
        }
      }
    }
  }

  async markMessagesRead(sessionId, chatJid, keys = []) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return false;
    try {
      if (Array.isArray(keys) && keys.length > 0) {
        await sock.readMessages(keys);
        return true;
      }
    } catch (err) {
      console.warn(`[WA READ] Failed to send read receipt for session ${sessionId}:`, err.message);
    }
    return false;
  }

  /**
   * Check if a session can reconnect based on cooldown period
   * @param {string} sessionId - The session ID
   * @param {boolean} force - Force bypass cooldown
   * @returns {boolean} - True if reconnect is allowed
   */
  canReconnect(sessionId, force = false) {
    if (force) return true;
    const lastReconnect = this.reconnectCooldown.get(sessionId) || 0;
    const now = Date.now();
    const timeSinceLastReconnect = now - lastReconnect;
    const cooldownMs = 15000; // 15 seconds cooldown

    if (timeSinceLastReconnect < cooldownMs) {
      console.log(
        `[WA RECONNECT] reconnect blocked (cooldown), ${Math.ceil((cooldownMs - timeSinceLastReconnect) / 1000)}s remaining`,
        {
          sessionId,
          lastReconnect: new Date(lastReconnect).toISOString(),
          timeSinceLastReconnect,
          cooldownMs,
        },
      );
      return false;
    }
    return true;
  }

  /**
   * Safely remove a socket from all tracking maps/sets
   * @param {string} sessionId - The session ID
   */
  removeSocket(sessionId) {
    this.destroySocket(sessionId);
    this.sockets.delete(sessionId);
    this.activeSockets.delete(sessionId);
    this.taskQueues.delete(sessionId);
    this.clearHeartbeat(sessionId);
  }

  /**
   * Universal WebSocket open check compatible with Baileys v7 WebSocketClient and standard WebSocket
   * @param {object} sock - Baileys WASocket instance
   * @returns {boolean}
   */
  isSocketOpen(sock) {
    if (!sock || sock._isDestroyed) return false;
    const ws = sock.ws;
    if (!ws) return false;
    if (typeof ws.isOpen === "boolean") return ws.isOpen;
    if (typeof ws.readyState === "number") return ws.readyState === 1;
    if (typeof ws.socket?.readyState === "number") return ws.socket.readyState === 1;
    return false;
  }

  /**
   * Universal WebSocket closed check
   * @param {object} sock - Baileys WASocket instance
   * @returns {boolean}
   */
  isSocketClosed(sock) {
    if (!sock || sock._isDestroyed) return true;
    const ws = sock.ws;
    if (!ws) return true;
    if (typeof ws.isClosed === "boolean") return ws.isClosed;
    if (typeof ws.readyState === "number") return ws.readyState === 3;
    if (typeof ws.socket?.readyState === "number") return ws.socket.readyState === 3;
    return false;
  }

  /**
   * Properly destroy a socket connection
   * @param {string} sessionId - The session ID
   */
  destroySocket(sessionId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return;
    sock._isDestroyed = true;

    try {
      // Remove all event listeners first so no trailing connection.update fires
      if (sock.ev) {
        sock.ev.removeAllListeners();
      }
      // Close the WebSocket connection safely
      if (sock.ws) {
        if (typeof sock.ws.close === "function" && !sock.ws.isClosed) {
          sock.ws.close();
        } else if (sock.ws.readyState && sock.ws.readyState !== 3) {
          sock.ws.close();
        }
      }
      // End the socket gracefully
      if (typeof sock.end === "function") {
        sock.end({ reason: "destroy" });
      }
    } catch (e) {
      // Ignore errors during cleanup
    }
  }

  /**
   * Calculate exponential backoff delay for reconnects
   * @param {string} sessionId - The session ID
   * @param {number} baseDelay - Base delay in ms (default: 2000)
   * @param {number} maxDelay - Maximum delay in ms (default: 30000)
   * @returns {number} - Delay in milliseconds
   */
  getReconnectDelay(sessionId, baseDelay = 2000, maxDelay = 30000) {
    const attempts = this.reconnectAttempts.get(sessionId) || 0;
    const delay = Math.min(maxDelay, baseDelay * Math.pow(1.5, attempts));
    console.log(
      `[WA BACKOFF] session ${sessionId}, attempts ${attempts}, delay ${delay}ms`,
    );
    return delay;
  }

  canTransitionSessionStatus(sessionId, currentStatus, nextStatus) {
    if (!nextStatus) {
      return false;
    }
    // Allow state refresh with same status to patch phone numbers/lastConnected
    if (currentStatus === nextStatus) {
      return true;
    }

    const isLiveConnected = this.isSessionWorking(sessionId);

    // A stale reconnect tick should not downgrade a socket that is already live.
    if (currentStatus === "connected" && nextStatus === "connecting") {
      return !isLiveConnected;
    }

    const allowedTransitions = {
      pending: ["connecting", "connected", "disconnected", "failed"],
      connecting: ["connected", "disconnected", "failed"],
      connected: ["connecting", "disconnected", "failed"],
      disconnected: ["connecting", "connected", "failed"],
      failed: ["connecting", "disconnected"],
    };

    return (allowedTransitions[currentStatus] || []).includes(nextStatus);
  }

  async handleSessionStateChange(sessionId, status, patch = {}) {
    const session = await SessionModel.findOne({ sessionId }).lean();
    if (!session) {
      return null;
    }

    if (!this.canTransitionSessionStatus(sessionId, session.status, status)) {
      return {
        skipped: true,
        sessionId,
        currentStatus: session.status,
        requestedStatus: status,
      };
    }

    const updateData = {
      status,
      ...patch,
    };

    await SessionModel.updateOne({ sessionId }, updateData).catch(() => {});
    const emitted = await this.emitSessionUpdate(sessionId, updateData);
    if (!emitted) {
      await this.emitSessionUpdate(sessionId, updateData);
    }

    if (this.io) {
      this.io.to(sessionId).emit("status", {
        sessionId,
        status,
        ...patch,
      });
    }

    return updateData;
  }

  normalizeJid(phoneNumber) {
    const rawValue = String(phoneNumber || "").trim();

    if (!rawValue) {
      throw new Error("Phone number is required");
    }

    if (rawValue.includes("@")) {
      if (rawValue.endsWith("@c.us")) {
        return rawValue.replace(/@c\.us$/, "@s.whatsapp.net");
      }
      return rawValue;
    }

    const digits = rawValue.replace(/\D/g, "");
    if (!digits) {
      throw new Error("Invalid phone number");
    }

    const normalizedDigits = digits.length === 10 ? `91${digits}` : digits;
    return `${normalizedDigits}@s.whatsapp.net`;
  }

  buildMessagePayload(message, mediaPath = null, mediaType = null, options = {}) {
    // If caller provided explicit Baileys AnyMessageContent payload (location, contacts, poll, react, pin, delete, etc.)
    if (options.payload) {
      return options.payload;
    }

    if (options.location) {
      return {
        location: {
          degreesLatitude: options.location.degreesLatitude || options.location.latitude,
          degreesLongitude: options.location.degreesLongitude || options.location.longitude,
          name: options.location.name,
          address: options.location.address,
        },
      };
    }

    if (options.contacts) {
      return {
        contacts: {
          displayName: options.contacts.displayName || options.contacts[0]?.displayName || "Contact",
          contacts: Array.isArray(options.contacts) ? options.contacts : [options.contacts],
        },
      };
    }

    if (options.poll) {
      return {
        poll: {
          name: options.poll.name || options.poll.question || "Poll",
          values: options.poll.values || options.poll.options || ["Option 1", "Option 2"],
          selectableCount: options.poll.selectableCount || 1,
          toAnnouncementGroup: !!options.poll.toAnnouncementGroup,
        },
      };
    }

    if (options.react) {
      return {
        react: {
          text: options.react.text || options.react.emoji || "",
          key: options.react.key,
        },
      };
    }

    if (options.pin) {
      return {
        pin: {
          type: options.pin.type !== undefined ? options.pin.type : 1,
          time: options.pin.time || options.pin.durationSeconds || 86400,
          key: options.pin.key,
        },
      };
    }

    if (options.delete) {
      return {
        delete: options.delete,
      };
    }

    if (options.forward) {
      return {
        forward: options.forward,
      };
    }

    if (!mediaPath || !mediaType) {
      const textPayload = { text: message || "" };
      if (Array.isArray(options.mentions) && options.mentions.length > 0) {
        textPayload.mentions = options.mentions;
      }
      return textPayload;
    }

    const mediaBuffer = readFileSync(mediaPath);
    const mime = String(mediaType || "").toLowerCase();

    if (mime.startsWith("image/")) {
      const payload = {
        image: mediaBuffer,
        mimetype: mediaType,
      };
      if (message) payload.caption = message;
      if (options.viewOnce) payload.viewOnce = true;
      if (Array.isArray(options.mentions) && options.mentions.length > 0) {
        payload.mentions = options.mentions;
      }
      return payload;
    }

    if (mime.startsWith("video/")) {
      const payload = {
        video: mediaBuffer,
        mimetype: mediaType,
      };
      if (message) payload.caption = message;
      if (options.gifPlayback) payload.gifPlayback = true;
      if (options.ptv) payload.ptv = true;
      if (options.viewOnce) payload.viewOnce = true;
      if (Array.isArray(options.mentions) && options.mentions.length > 0) {
        payload.mentions = options.mentions;
      }
      return payload;
    }

    if (mime.startsWith("audio/")) {
      const payload = {
        audio: mediaBuffer,
        mimetype: mediaType || "audio/mp4",
        ptt: options.ptt !== undefined ? !!options.ptt : (mime.includes("ogg") || mime.includes("opus")),
      };
      if (options.viewOnce) payload.viewOnce = true;
      return payload;
    }

    const docPayload = {
      document: mediaBuffer,
      mimetype: mediaType || "application/octet-stream",
      fileName: options.fileName || basename(mediaPath),
    };
    if (message) docPayload.caption = message;
    if (Array.isArray(options.mentions) && options.mentions.length > 0) {
      docPayload.mentions = options.mentions;
    }
    return docPayload;
  }

  async sendMessage(
    sessionId,
    phoneNumber,
    message,
    mediaPath = null,
    mediaType = null,
    options = {},
  ) {
    const sock = this.sockets.get(sessionId);

    if (!sock) {
      throw new Error("Session is not connected");
    }

    const jid = this.normalizeJid(phoneNumber);
    if (isMetaAiJid(jid)) {
      try {
        const botInfo = await resolveMetaAiBot(sock, sessionId);
        options.contextInfo = {
          ...(options.contextInfo || {}),
          botMetadata: {
            personaId: botInfo.personaId || "867051314767696$760019659443059",
          },
        };
      } catch (_) {}
    }
    const payload = this.buildMessagePayload(message, mediaPath, mediaType, options);

    const sendOptions = {};
    if (options.quoted) sendOptions.quoted = options.quoted;
    if (options.ephemeralExpiration) sendOptions.ephemeralExpiration = options.ephemeralExpiration;
    if (options.statusJidList) sendOptions.statusJidList = options.statusJidList;

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      if (!sock?.user?.id || !this.isSocketOpen(sock)) {
        throw new Error("Session is not connected or reconnecting");
      }
      const result = await sock.sendMessage(jid, payload, sendOptions);
      if (result?.key?.id && result?.message) {
        this.setCachedMessage(result.key.id, result.message);
      }
      return result;
    });
  }

  /**
   * Send reaction emoji to a message
   */
  async sendReaction(sessionId, chatJid, messageKey, emoji) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    const jid = this.normalizeJid(chatJid);

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      return await sock.sendMessage(jid, {
        react: {
          text: emoji || "",
          key: messageKey,
        },
      });
    });
  }

  /**
   * Pin or unpin a message in a chat
   * @param {string} sessionId
   * @param {string} chatJid
   * @param {object} messageKey
   * @param {number} pinType - 1 to pin, 0 to unpin
   * @param {number} durationSeconds - 86400 (24h), 604800 (7d), 2592000 (30d)
   */
  async pinMessage(sessionId, chatJid, messageKey, pinType = 1, durationSeconds = 86400) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    const jid = this.normalizeJid(chatJid);

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      return await sock.sendMessage(jid, {
        pin: {
          type: pinType,
          time: durationSeconds,
          key: messageKey,
        },
      });
    });
  }

  /**
   * Delete message for everyone (Revoke)
   */
  async deleteMessageForEveryone(sessionId, chatJid, messageKey) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    const jid = this.normalizeJid(chatJid);

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      return await sock.sendMessage(jid, {
        delete: messageKey,
      });
    });
  }

  /**
   * Send Presence Update ('composing', 'recording', 'paused', 'available', 'unavailable')
   */
  async sendPresence(sessionId, chatJid, presenceType = "composing") {
    const sock = this.sockets.get(sessionId);
    if (!sock) return false;
    const jid = this.normalizeJid(chatJid);
    try {
      await sock.sendPresenceUpdate(presenceType, jid);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Subscribe to presence updates for a chat/contact
   */
  async subscribePresence(sessionId, chatJid) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return false;
    const jid = this.normalizeJid(chatJid);
    try {
      await sock.presenceSubscribe(jid);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Modify chat state on WhatsApp (pin, mute, archive, star, clear)
   */
  async modifyChat(sessionId, chatJid, modification) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    const jid = this.normalizeJid(chatJid);

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      return await sock.chatModify(modification, jid);
    });
  }

  /**
   * Pin or unpin a conversation
   */
  async pinChat(sessionId, chatJid, pin = true) {
    return this.modifyChat(sessionId, chatJid, { pin: !!pin });
  }

  /**
   * Mute or unmute a conversation
   * @param {number|null} durationMs - e.g. 8 * 60 * 60 * 1000 for 8h, or null to unmute
   */
  async muteChat(sessionId, chatJid, durationMs = null) {
    return this.modifyChat(sessionId, chatJid, { mute: durationMs });
  }

  /**
   * Archive or unarchive a conversation
   */
  async archiveChat(sessionId, chatJid, archive = true, lastMessages = []) {
    return this.modifyChat(sessionId, chatJid, { archive: !!archive, lastMessages });
  }

  /**
   * Star or unstar a message
   */
  async starMessage(sessionId, chatJid, messageId, fromMe = true, star = true) {
    return this.modifyChat(sessionId, chatJid, {
      star: {
        messages: [{ id: messageId, fromMe: !!fromMe }],
        star: !!star,
      },
    });
  }

  /**
   * Set Disappearing / Ephemeral Messages in Chat
   * @param {number} durationSeconds - 0 to disable, 86400 (24h), 604800 (7d), 7776000 (90d)
   */
  async setDisappearingMessages(sessionId, chatJid, durationSeconds = 0) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    const jid = this.normalizeJid(chatJid);

    return this.enqueueSessionTask(sessionId, async () => {
      await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});
      return await sock.sendMessage(jid, {
        disappearingMessagesInChat: durationSeconds > 0 ? durationSeconds : false,
      });
    });
  }

  /**
   * Check if phone numbers exist on WhatsApp
   */
  async checkOnWhatsApp(sessionId, jids = []) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    if (!Array.isArray(jids) || jids.length === 0) return [];
    const cleanJids = jids.map((j) => {
      try {
        return this.normalizeJid(j);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    if (cleanJids.length === 0) return [];
    return await sock.onWhatsApp(...cleanJids);
  }

  /**
   * Fetch WhatsApp About/Status for contact
   */
  async fetchStatus(sessionId, jid) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return null;
    const cleanJid = this.normalizeJid(jid);
    try {
      const status = await sock.fetchStatus(cleanJid);
      return status?.status || null;
    } catch (e) {
      return null;
    }
  }

  startHeartbeat(sessionId, sock) {
    this.clearHeartbeat(sessionId);
    console.log("[WA HEARTBEAT] started", {
      sessionId,
      activeSockets: this.sockets.size,
      activeHeartbeats: this.heartbeats.size,
    });

    const id = setInterval(async () => {
      try {
        const liveSock = this.sockets.get(sessionId) || sock;
        const isAuthenticated = !!liveSock?.user?.id;
        const isOpen = this.isSocketOpen(liveSock);

        console.log("[WA HEARTBEAT] tick", {
          sessionId,
          isAuthenticated,
          isOpen,
          activeSockets: this.sockets.size,
        });

        // If the session is authenticated and open, treat it as healthy.
        if (isAuthenticated && isOpen) {
          return;
        }

        console.log("[WA HEARTBEAT] connection or auth lost, reconnecting", { sessionId, isAuthenticated, isOpen });

        this.clearHeartbeat(sessionId);

        await this.handleSessionStateChange(sessionId, "connecting");

        this.reconnectSession(sessionId).catch((err) =>
          console.error("[WA HEARTBEAT] reconnect error", err),
        );
      } catch (err) {
        console.error("[WA HEARTBEAT ERROR]", err);
      }
    }, 60_000);
    this.heartbeats.set(sessionId, id);
  }

  async getSocketVersion() {
    try {
      const { version } = await fetchLatestBaileysVersion();
      return version;
    } catch (e) {
      return undefined;
    }
  }

  async removeSessionFiles(sessionId) {
    try {
      await WhatsAppAuthState.deleteMany({ sessionId });
      console.log("[WA AUTH] Mongo auth state cleared", { sessionId });
    } catch (e) {
      console.error("[WA AUTH] failed to clear Mongo auth state", { sessionId, error: e.message });
    }
    const sessionPath = join(SESSIONS_DIR, sessionId);
    try {
      if (existsSync(sessionPath)) {
        rmSync(sessionPath, { recursive: true, force: true });
      }
    } catch (e) {}
  }

  isValidAuthState(authState) {
    if (!authState || !authState.state) return false;
    const creds = authState.state.creds;
    if (!creds) return false;
    if (!creds.me || !creds.me.id) return false;
    // Don't require 'registered' to be true - after pairing but before
    // complete registration, registered might be false temporarily
    // This prevents marking valid sessions as invalid after 515 restart
    return true;
  }

  async validateSessionCredentials(sessionId) {
    try {
      const doc = await WhatsAppAuthState.findOne({ sessionId, dataType: "creds", dataId: "creds" }).lean();
      if (!doc || !doc.dataJson) {
        console.log("[WA CREDS] mongo entry missing", { sessionId });
        return false;
      }
      const creds = JSON.parse(doc.dataJson);
      if (
        !creds ||
        typeof creds !== "object" ||
        Object.keys(creds).length === 0
      ) {
        console.warn("[WA CREDS] corrupted/empty in mongo", { sessionId });
        return false;
      }
      return true;
    } catch (err) {
      console.error("[WA CREDS] validation error", {
        sessionId,
        error: err.message,
      });
      return false;
    }
  }

  // Core socket factory + event handlers
  async createSocket(sessionId, authState) {
    // Prevent duplicate active sockets
    if (this.activeSockets.has(sessionId)) {
      console.log(
        `[WA SOCKET] socket already active for session ${sessionId}, skipping creation`,
      );
      return this.sockets.get(sessionId);
    }

    const io = this.io;
    let isLoggingOut = false;
    let hasGeneratedQR = false;

    const version = await this.getSocketVersion();
    const sock = makeWASocket({
      auth: authState.state,
      version,
      printQRInTerminal: false,
      browser: Browsers.appropriate("Chrome"),
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      fireInitQueries: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      maxMsgRetryCount: 5,
      cachedGroupMetadata: async (jid) => {
        try {
          const cached = this.getGroupMetadataFromCache(sessionId, jid);
          if (cached) return cached;
          const meta = await sock.groupMetadata(jid);
          if (meta) {
            if (meta.participants) {
              await resolveGroupParticipantsLids(sock, meta.participants);
            }
            this.setGroupMetadataInCache(sessionId, jid, meta);
          }
          return meta;
        } catch (err) {
          return undefined;
        }
      },
      getMessage: async (key) => {
        if (!key?.id) return undefined;
        const inMem = this.getCachedMessage(key.id);
        if (inMem) return inMem;
        try {
          const dbMsg = await WaChatMessage.findOne({ messageId: key.id }).lean();
          if (dbMsg && dbMsg.text) {
            return {
              conversation: dbMsg.text,
            };
          }
        } catch (err) {
          console.warn(`[WA RETRY] Error getting message for key ${key.id}:`, err.message);
        }
        return undefined;
      },
    });

    // Add to active sockets tracking
    sock.authState = authState;
    this.sockets.set(sessionId, sock);
    this.activeSockets.add(sessionId);

    // CRITICAL: Wire saveCreds with error tracking and ensure it's called
    // Track last save time to prevent immediate restart before save
    let lastCredsSaveTime = 0;
    let saveCredsPending = false;

    const saveCredsWrapper = async () => {
      try {
        console.log(
          "[WA PERSIST] creds.update event triggered, saving credentials...",
          { sessionId },
        );
        saveCredsPending = true;
        await authState.saveCreds();
        lastCredsSaveTime = Date.now();
        saveCredsPending = false;
        console.log("[WA PERSIST] credentials saved to disk successfully", {
          sessionId,
          saveTime: new Date(lastCredsSaveTime).toISOString(),
        });
      } catch (err) {
        saveCredsPending = false;
        console.error("[WA PERSIST] failed to save creds", {
          sessionId,
          error: err.message,
          stack: err.stack,
        });
      }
    };

    // Attach the wrapper to creds.update event
    sock.ev.on("creds.update", saveCredsWrapper);

    // Credential updates are persisted automatically via creds.update event

    // QR handling
    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log(`[WA AUTH] session ${sessionId} connecting...`);
      }

      if (qr) {
        hasGeneratedQR = true;
        try {
          qrcode.toDataURL(qr, (err, url) => {
            if (!err && url) {
              this.pendingQRCodes.set(sessionId, url);
              this.emitSessionUpdate(sessionId, { status: "qr" });
              if (io) {
                io.to(sessionId).emit("qrcode", { sessionId, qr: url });
                io.to(sessionId).emit("status", { sessionId, status: "qr" });
              }
            }
          });
        } catch (e) {}
      }

      if (connection === "open") {
        // Mark connected
        const phone = (sock.user?.id || "").split("@")[0].split(":")[0];
        const isValidCreds = this.isValidAuthState(authState);
        console.log("[WA AUTH] connection open", {
          sessionId,
          phone,
          hasValidCreds: isValidCreds,
          registered: !!authState.state.creds?.registered,
        });

        this.pendingQRCodes.delete(sessionId);
        this.reconnectAttempts.delete(sessionId);
        this.reconnectCooldown.delete(sessionId); // Reset cooldown on successful connection
        this.sockets.set(sessionId, sock);
        await this.handleSessionStateChange(sessionId, "connected", {
          phoneNumber: phone,
          lastConnected: new Date(),
        });
        this.startHeartbeat(sessionId, sock);

        // Initial background group sync into MongoDB (non-blocking)
        setTimeout(() => {
          this.syncSessionGroups(sessionId, { prune: true }).catch((err) => {
            console.warn(`[WA GROUP SYNC] Initial sync background error for ${sessionId}:`, err.message);
          });
        }, 2500);
      }

      if (connection === "close") {
        if (isLoggingOut || sock._isDestroyed) {
          this.clearHeartbeat(sessionId);
          return;
        }

        const statusCode = lastDisconnect?.error?.output?.statusCode ?? null;
        const reason =
          statusCode ??
          (lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output.statusCode
            : 0);
        const isLogout =
          statusCode === 401 || reason === DisconnectReason.loggedOut;
        const isRestartRequired = reason === DisconnectReason.restartRequired;
        const isTemporaryWebsocketBreak = statusCode === 428 || reason === 428;
        const isSoftRestart = statusCode === 515 || isTemporaryWebsocketBreak; // Stream error 515 or temporary 428 hiccup
        const isRegistered = !!authState.state.creds?.registered;
        const attempts = this.reconnectAttempts.get(sessionId) || 0;
        const isValidCreds = this.isValidAuthState(authState);

        console.log("[WA AUTH] connection close", {
          sessionId,
          statusCode,
          reason,
          isLogout,
          isRestartRequired,
          isSoftRestart,
          isRegistered,
          isValidCreds,
          attempts,
        });

        this.clearHeartbeat(sessionId);

        // Handle restartRequired first - recreate socket immediately
        if (isRestartRequired) {
          console.log("[WA AUTH] restartRequired received, recreating socket immediately", { sessionId });
          this.removeSocket(sessionId);
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(
            () => this.reconnectSession(sessionId, { isRestart: true }).catch(() => {}),
            500
          );
          return;
        }

        // CRITICAL: Handle soft restart (515) BEFORE checking invalid creds
        // 515 means temporary stream disconnect, NOT auth failure - preserve session
        if (isSoftRestart) {
          // Check if credentials are currently being saved
          const now = Date.now();
          const timeSinceLastSave = now - lastCredsSaveTime;
          const isSavingInProgress = saveCredsPending;

          // If credentials are being saved or were saved very recently, wait longer
          let additionalWait = 0;
          if (isSavingInProgress) {
            console.log(
              "[WA RESTART] credentials save in progress, waiting 3 seconds...",
              { sessionId },
            );
            additionalWait = 3000; // Wait 3 seconds for save to complete
          } else if (timeSinceLastSave < 2000) {
            console.log(
              "[WA RESTART] credentials saved recently, waiting 2 seconds...",
              {
                sessionId,
                timeSinceLastSave,
              },
            );
            additionalWait = 2000; // Wait 2 seconds if saved within last 2 seconds
          }

          const baseDelay = this.getReconnectDelay(sessionId, 5000, 30000); // Base 5s for 515, max 30s
          const totalDelay = baseDelay + additionalWait;

          console.log(
            `[WA RESTART] soft restart (515), preserving credentials - delaying reconnect by ${totalDelay}ms`,
            {
              sessionId,
              baseDelay,
              additionalWait,
              totalDelay,
              isSavingInProgress,
              timeSinceLastSave,
              lastSaveTime:
                lastCredsSaveTime > 0
                  ? new Date(lastCredsSaveTime).toISOString()
                  : "never",
            },
          );

          // Give a small grace period for any pending saveCreds to complete
          if (additionalWait > 0) {
            await new Promise((resolve) => setTimeout(resolve, additionalWait));
          }

          this.removeSocket(sessionId);
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(
            () => this.reconnectSession(sessionId).catch(() => {}),
            baseDelay, // Use base delay for the actual reconnect
          );
          return;
        }

        // If temporarily invalid or retrying, do NOT wipe Mongo auth state!
        // Auth state must ONLY be deleted on explicit logout or user deletion.
        if (!isValidCreds && attempts > 3) {
          console.warn(
            "[WA AUTH] Session disconnected after retries, marking disconnected without deleting creds",
            { sessionId, attempts },
          );
          await this.handleSessionStateChange(sessionId, "disconnected");
          this.removeSocket(sessionId);
          return;
        }

        // Handle conflict (replaced / statusCode 440 / Stream Errored conflict) FIRST!
        const isConflict =
          statusCode === 440 ||
          reason === 440 ||
          String(lastDisconnect?.error?.message || "").toLowerCase().includes("conflict") ||
          String(lastDisconnect?.error?.toString() || "").toLowerCase().includes("conflict");

        if (isConflict) {
          const nextAttempts = (this.reconnectAttempts.get(sessionId) || 0) + 1;
          this.reconnectAttempts.set(sessionId, nextAttempts);

          if (nextAttempts > 4) {
            console.warn(
              `[WA CONFLICT] Session ${sessionId} repeatedly conflicted (replaced by another connection). Pausing auto-reconnect without deleting creds.`,
            );
            this.removeSocket(sessionId);
            await this.handleSessionStateChange(sessionId, "disconnected", {
              error: "WhatsApp connection conflicted with another device/socket. Reconnect when ready.",
            });
            return;
          }

          // Backoff with minimum 8s to 25s so previous ghost socket closes cleanly on WhatsApp server
          const conflictDelay = Math.min(25000, 8000 * Math.pow(1.5, nextAttempts - 1));
          console.log(
            `[WA CONFLICT] Session ${sessionId} stream conflict detected. Backing off for ${conflictDelay}ms (attempt ${nextAttempts}/4)...`,
          );
          this.removeSocket(sessionId);
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(
            () => this.reconnectSession(sessionId).catch(() => {}),
            conflictDelay,
          );
          return;
        }

        const errorData = lastDisconnect?.error?.data;
        const errorLocation = errorData?.location;
        const isDefinitiveRevoke =
          (statusCode === 401 || reason === 401) &&
          (errorLocation === "lla" || errorLocation === "cco" || attempts >= 2);

        // Handle confirmed WhatsApp companion logout / revoked linked session
        if (isLogout) {
          console.warn("[WA AUTH] session disconnected/logged out from WhatsApp", {
            sessionId,
            reason,
            statusCode,
            location: errorLocation,
            isDefinitiveRevoke,
            attempts,
          });

          // If WhatsApp confirmed companion token revocation (lla/cco) or retries exhausted:
          if (isDefinitiveRevoke) {
            console.warn(
              `[WA AUTH] WhatsApp server permanently revoked session ${sessionId} (${errorLocation || 'loggedOut'}). Clearing stale keys and setting status to 'disconnected'.`
            );
            await this.removeSessionFiles(sessionId);
            this.removeSocket(sessionId);
            this.clearHeartbeat(sessionId);
            this.reconnectAttempts.delete(sessionId);
            this.reconnectCooldown.delete(sessionId);
            await this.handleSessionStateChange(sessionId, "disconnected", {
              error: "WhatsApp unlinked this device. Please scan QR to re-link.",
            });
            if (this.io) {
              this.io.to(sessionId).emit("session:unlinked", {
                sessionId,
                error: "WhatsApp unlinked this device. Please scan QR to re-link.",
              });
            }
            return;
          }

          // If first 401 without definitive revoke flags, retry ONCE after 5s before declaring unlinked
          if (attempts < 1) {
            const nextAttempts = attempts + 1;
            this.reconnectAttempts.set(sessionId, nextAttempts);
            console.log(`[WA AUTH] Transient 401 for ${sessionId}, retrying once in 5s (attempt ${nextAttempts}/2)...`);
            this.removeSocket(sessionId);
            await this.handleSessionStateChange(sessionId, "connecting");
            setTimeout(() => this.reconnectSession(sessionId).catch(() => {}), 5000);
            return;
          }

          // Retries exhausted
          await this.removeSessionFiles(sessionId);
          this.removeSocket(sessionId);
          this.clearHeartbeat(sessionId);
          await this.handleSessionStateChange(sessionId, "disconnected", {
            error: "WhatsApp session expired. Please scan QR to re-link.",
          });
          return;
        }

        // Temporary disconnects with valid auth: mark connecting and attempt reconnect
        if (isValidCreds) {
          const delay = this.getReconnectDelay(sessionId, 3000, 30000);
          console.log(
            `[WA RECONNECT] soft disconnect with valid auth, reconnecting in ${delay}ms`,
            { sessionId, isValidCreds, delay },
          );
          this.removeSocket(sessionId);
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(
            () => this.reconnectSession(sessionId).catch(() => {}),
            delay,
          );
          return;
        }

        // Pre-auth flows: don't wipe creds if QR already issued; try a quick reconnect
        if (!isRegistered && hasGeneratedQR) {
          const delay = this.getReconnectDelay(sessionId, 2500, 20000);
          console.log(
            `[WA RECONNECT] pre-auth with QR, reconnecting in ${delay}ms`,
            { sessionId, delay },
          );
          this.removeSocket(sessionId);
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(
            () => this.reconnectSession(sessionId).catch(() => {}),
            delay,
          );
          return;
        }

        // Fresh sessions without QR generated yet
        if (!isRegistered && !hasGeneratedQR) {
          console.log("[WA AUTH] waiting for QR scan", { sessionId });
          return;
        }

        // If creds exist, schedule a recovery reconnect; otherwise mark disconnected
        const hasCreds = await this.validateSessionCredentials(sessionId);
        if (hasCreds) {
          const delay = this.getReconnectDelay(sessionId, 15000, 60000); // Base 15s, max 60s for recovery
          console.log(
            `[WA RECONNECT] recovery reconnect scheduled in ${delay}ms`,
            { sessionId, delay },
          );
          await this.handleSessionStateChange(sessionId, "connecting");
          setTimeout(() => {
            if (!this.sockets.has(sessionId)) {
              this.reconnectSession(sessionId).catch(() => {
                this.handleSessionStateChange(sessionId, "disconnected").catch(
                  () => {},
                );
              });
            }
          }, delay);
        } else {
          await this.handleSessionStateChange(sessionId, "disconnected");
        }
      }
    });

    // Save incoming/outgoing messages and handle AI Agent responses
    sock.ev.on("messages.upsert", async (m) => {
      if (m.type === "notify") {
        for (const msg of m.messages) {
          if (msg.message) {
            this.setCachedMessage(msg.key.id, msg.message);
            const isFromMe = !!msg.key.fromMe;
            const rawSenderJid = msg.key.remoteJid;
            const senderJid = rawSenderJid ? jidNormalizedUser(rawSenderJid) : "";
            const participantJid = msg.key.participant ? jidNormalizedUser(msg.key.participant) : (isFromMe ? null : senderJid);
            // Unwrap message contents (handling ephemeral, view-once, and interactive templates)
            const isProtocolEdit = !!(
              msg.message?.protocolMessage?.editedMessage ||
              msg.message?.protocolMessage?.type === 14 ||
              msg.message?.editedMessage?.message
            );
            const targetEditMessageId = isProtocolEdit
              ? msg.message?.protocolMessage?.key?.id || msg.message?.editedMessage?.key?.id
              : null;
            const editedMsgWrap =
              msg.message?.protocolMessage?.editedMessage ||
              msg.message?.editedMessage?.message;

            const rawMsg =
              editedMsgWrap ||
              msg.message?.ephemeralMessage?.message ||
              msg.message?.viewOnceMessage?.message ||
              msg.message?.viewOnceMessageV2?.message ||
              msg.message?.documentWithCaptionMessage?.message ||
              msg.message;
            const msgContent = rawMsg?.viewOnceMessage?.message || rawMsg;

            const text =
              msgContent?.conversation ||
              msgContent?.extendedTextMessage?.text ||
              msgContent?.imageMessage?.caption ||
              msgContent?.videoMessage?.caption ||
              msgContent?.documentMessage?.caption ||
              msgContent?.buttonsResponseMessage?.selectedButtonId ||
              msgContent?.buttonsResponseMessage?.selectedDisplayText ||
              msgContent?.templateButtonReplyMessage?.selectedId ||
              msgContent?.templateButtonReplyMessage?.selectedDisplayText ||
              msgContent?.listResponseMessage?.title ||
              msgContent?.listResponseMessage?.singleSelectReply?.selectedRowId ||
              "";

            // If this is a progressive streamed edit (e.g. Meta AI generating text), update the existing message in DB and emit
            if (isProtocolEdit && targetEditMessageId) {
              if (text) {
                const updatedMsgDoc = await WaChatMessage.findOneAndUpdate(
                  { messageId: targetEditMessageId, sessionId },
                  { $set: { text } },
                  { new: true }
                );
                if (updatedMsgDoc && this.io) {
                  this.io.to(sessionId).emit("chat:message_update", {
                    sessionId,
                    chatJid: updatedMsgDoc.chatJid,
                    messageId: targetEditMessageId,
                    text,
                  });
                  this.io.to(sessionId).emit("chat:message", {
                    sessionId,
                    chatJid: updatedMsgDoc.chatJid,
                    message: updatedMsgDoc,
                  });
                }
              }
              continue;
            }

            const mediaType = msgContent?.imageMessage
              ? "image"
              : msgContent?.videoMessage
                ? "video"
                : msgContent?.documentMessage
                  ? "document"
                  : msgContent?.audioMessage
                    ? "audio"
                    : null;
            const timestamp = msg.messageTimestamp
              ? new Date(Number(msg.messageTimestamp) * 1000)
              : new Date();

            // Extract Quoted / Replied Message
            const contextInfo =
              msgContent?.extendedTextMessage?.contextInfo ||
              msgContent?.imageMessage?.contextInfo ||
              msgContent?.videoMessage?.contextInfo ||
              msgContent?.documentMessage?.contextInfo ||
              msgContent?.audioMessage?.contextInfo;

            let quotedMessage = null;
            if (contextInfo && (contextInfo.stanzaId || contextInfo.quotedMessage)) {
              const qMsg = contextInfo.quotedMessage;
              const qText =
                qMsg?.conversation ||
                qMsg?.extendedTextMessage?.text ||
                qMsg?.imageMessage?.caption ||
                qMsg?.videoMessage?.caption ||
                qMsg?.documentMessage?.caption ||
                (qMsg?.imageMessage ? "Photo" : qMsg?.videoMessage ? "Video" : qMsg?.audioMessage ? "Voice note" : qMsg?.documentMessage ? "Document" : "");

              quotedMessage = {
                messageId: contextInfo.stanzaId || null,
                participant: contextInfo.participant || null,
                text: qText || null,
                mediaType: qMsg?.imageMessage ? "image" : qMsg?.videoMessage ? "video" : qMsg?.documentMessage ? "document" : qMsg?.audioMessage ? "audio" : null,
              };
            }

            // Resolve WhatsApp @lid JID to Phone Number if applicable
            let resolvedSenderJid = senderJid;
            const isMetaAi = isMetaAiJid(rawSenderJid) || isMetaAiJid(senderJid);
            if (isMetaAi) {
              resolvedSenderJid = META_AI_NORMALIZED_JID;
            } else if (senderJid && senderJid.endsWith("@lid")) {
              try {
                const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID(senderJid);
                if (pnJid) {
                  resolvedSenderJid = jidNormalizedUser(pnJid);
                }
              } catch (lidErr) {}
            } else if (resolvedSenderJid) {
              resolvedSenderJid = jidNormalizedUser(resolvedSenderJid);
            }
            let resolvedPhoneNumber = isMetaAi
              ? "13135550002"
              : (resolvedSenderJid ? resolvedSenderJid.replace(/@.*/, "").replace(/:\d+$/, "") : "");

            // Download incoming or outgoing WhatsApp media (Image, Video, Audio, Document)
            let mediaUrl = null;
            let mediaName = null;
            if (mediaType) {
              try {
                const buffer = await downloadMediaMessage(
                  msg,
                  "buffer",
                  {},
                  {
                    reuploadRequest: sock.updateMediaMessage,
                  }
                );
                if (buffer && buffer.length > 0) {
                  const mime =
                    msgContent?.imageMessage?.mimetype ||
                    msgContent?.videoMessage?.mimetype ||
                    msgContent?.documentMessage?.mimetype ||
                    msgContent?.audioMessage?.mimetype ||
                    "";

                  let ext = "bin";
                  if (mediaType === "image") {
                    ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
                  } else if (mediaType === "video") {
                    ext = "mp4";
                  } else if (mediaType === "audio") {
                    ext = mime.includes("ogg") ? "ogg" : "mp3";
                  } else if (mediaType === "document") {
                    const originalName = msgContent?.documentMessage?.fileName;
                    if (originalName && originalName.includes(".")) {
                      ext = originalName.split(".").pop();
                    } else {
                      ext = mime.includes("pdf") ? "pdf" : "bin";
                    }
                    mediaName = originalName || `document_${Date.now()}.${ext}`;
                  }

                  const uploadsDir = join(process.cwd(), "uploads", "chat_media");
                  if (!existsSync(uploadsDir)) {
                    mkdirSync(uploadsDir, { recursive: true });
                  }
                  const filename = `media_${Date.now()}_${Math.random().toString(36).substring(2, 8)}.${ext}`;
                  const filePath = join(uploadsDir, filename);
                  writeFileSync(filePath, buffer);
                  mediaUrl = `/uploads/chat_media/${filename}`;
                  if (!mediaName) mediaName = filename;
                }
              } catch (dlErr) {
                console.warn(`[WA MEDIA] Could not auto-download ${mediaType} for msg ${msg.key.id}:`, dlErr.message);
              }
            }

            // Retrieve session model scoped to this message loop
            let session = null;
            try {
              session = await SessionModel.findOne({ sessionId });
              if (session) {
                const savedMsg = await WaChatMessage.findOneAndUpdate(
                  { messageId: msg.key.id, sessionId },
                  {
                    $set: {
                      userId: session.userId,
                      sessionId,
                      chatJid: resolvedSenderJid,
                      participantJid,
                      messageId: msg.key.id,
                      text: text || "",
                      direction: isFromMe ? "out" : "in",
                      status: isFromMe ? "sent" : "read",
                      mediaType,
                      ...(mediaUrl ? { mediaUrl } : {}),
                      ...(mediaName ? { mediaName } : {}),
                      ...(quotedMessage ? { quotedMessage } : {}),
                      timestamp,
                    },
                  },
                  { upsert: true, new: true }
                );

                // Update or create WaChat last message
                const isGroup = resolvedSenderJid.endsWith("@g.us");
                const contactName = isMetaAi ? "Meta AI" : (msg.pushName || "");
                
                // If direct chat, look up if an existing WaChat already has a custom name (e.g. "hh")
                let existingName = isMetaAi ? "Meta AI" : "";
                if (!isGroup && !isMetaAi) {
                  const existingChat = await WaChat.findOne({
                    userId: session.userId,
                    sessionId,
                    chatJid: resolvedSenderJid,
                  }).lean();
                  if (existingChat && existingChat.name && !existingChat.name.includes(":")) {
                    existingName = existingChat.name;
                  }
                }

                await WaChat.findOneAndUpdate(
                  { userId: session.userId, sessionId, chatJid: resolvedSenderJid },
                  {
                    $set: {
                      lastMessage: text || (mediaType ? `[${mediaType}]` : ""),
                      lastMessageTime: timestamp,
                      isGroup,
                      phoneNumber: resolvedPhoneNumber,
                    },
                    $setOnInsert: {
                      name: existingName || contactName || (isGroup ? "WhatsApp Group" : `+${resolvedPhoneNumber}`),
                      contactName: contactName,
                    },
                    ...(isFromMe ? {} : { $inc: { unreadCount: 1 } }),
                  },
                  { upsert: true }
                );

                // Emit realtime socket event scoped to the session and user room
                if (this.io) {
                  const socketPayload = {
                    sessionId,
                    chatJid: resolvedSenderJid,
                    rawJid: senderJid,
                    from: resolvedPhoneNumber,
                    message: savedMsg,
                  };
                  this.io.to(sessionId).emit("chat:message", socketPayload);
                  if (session.userId) {
                    this.io.to(`user:${session.userId.toString()}`).emit("chat:message", socketPayload);
                  }
                }

                // If this is an incoming message from the contact, all prior outgoing messages in this chat
                // have now been seen and read by the contact (turning single tick / delivered tick into double blue ticks)!
                if (!isFromMe) {
                  try {
                    const basePhone = resolvedPhoneNumber || resolvedSenderJid.replace(/@.*/, "").replace(/:\d+$/, "");
                    const candidateOutJids = [
                      resolvedSenderJid,
                      senderJid,
                      `${basePhone}@s.whatsapp.net`,
                      `${basePhone}:0@s.whatsapp.net`,
                      `${basePhone}:1@s.whatsapp.net`,
                      `${basePhone}@c.us`,
                    ].filter(Boolean);

                    const prevOutgoing = await WaChatMessage.find({
                      sessionId,
                      chatJid: { $in: candidateOutJids },
                      direction: "out",
                      timestamp: { $lte: timestamp },
                      status: { $ne: "read" },
                    }).select("messageId").lean();

                    if (prevOutgoing.length > 0) {
                      const prevIds = prevOutgoing.map((m) => m.messageId);
                      await WaChatMessage.updateMany(
                        { messageId: { $in: prevIds } },
                        { $set: { status: "read" } }
                      );
                      if (this.io) {
                        for (const pId of prevIds) {
                          const statusPayload = {
                            sessionId,
                            messageId: pId,
                            status: "read",
                          };
                          this.io.to(sessionId).emit("chat:message_status", statusPayload);
                          if (session?.userId) {
                            this.io.to(`user:${session.userId.toString()}`).emit("chat:message_status", statusPayload);
                          }
                        }
                      }
                    }
                  } catch (outReadErr) {
                    console.warn("[WA OUTGOING READ] Error auto-resolving read ticks:", outReadErr.message);
                  }
                }

                // Auto-sync CRM Contact interaction timestamp & stats
                if (!isGroup && session.userId) {
                  try {
                    const rawDigits = (resolvedPhoneNumber || resolvedSenderJid.replace(/@.*/, "").replace(/:\d+$/, "")).replace(/[^\d]/g, "");
                    const cleanPhone = rawDigits.replace(/^0+/, "");
                    if (cleanPhone) {
                      const snippet = (text || (mediaType ? `[${mediaType}]` : "")).slice(0, 300);
                      CrmContact.findOneAndUpdate(
                        { userId: session.userId, phone: cleanPhone },
                        {
                          $set: {
                            lastInteraction: timestamp || new Date(),
                            lastInteractionText: snippet,
                            chatJid: resolvedSenderJid,
                          },
                          $inc: { totalConversations: 1 },
                        }
                      ).exec().catch(() => {});
                    }
                  } catch (_) {}
                }
              }
            } catch (saveErr) {
              console.error("[WA MESSAGE] Failed to save message:", saveErr.message);
            }

            // Process incoming replies for Drip Campaigns & AI Agent
            if (!isFromMe) {
              const effectiveUserId = session?.userId || null;
              const cleanText = text || (mediaType ? `[${mediaType}]` : "");
              console.log(
                `[WA INCOMING] Msg from ${resolvedSenderJid || senderJid} (${resolvedPhoneNumber}): "${cleanText}" (sessionId: ${sessionId})`
              );

              // Check active drip sequences and stop sequence on customer reply
              dripService
                .handleIncomingReply(effectiveUserId, sessionId, resolvedSenderJid || senderJid, cleanText, resolvedPhoneNumber)
                .catch((err) => console.error("[WA MESSAGE] Drip trigger error:", err.message));

              handleIncomingMessage(sessionId, senderJid, text, async (jid, content) => {
                 // Show typing effect on WhatsApp
                 await sock.sendPresenceUpdate('composing', jid);
                 // Add a slight delay to make typing look natural
                 await new Promise(resolve => setTimeout(resolve, 2000));
                 await sock.sendMessage(jid, { text: content });
                 await sock.sendPresenceUpdate('paused', jid);
              }).catch(err => console.error("[WA MESSAGE] AI Agent error:", err));
            }
          }
        }
      }
    });

    // Listen to real-time message status updates (sent -> delivered -> read / blue tick)
    sock.ev.on("messages.update", async (updates) => {
      for (const update of updates || []) {
        if (!update.key?.id) continue;
        const msgId = update.key.id;
        const statusVal = update.update?.status !== undefined ? update.update.status : update.status;

        // Baileys status mapping: 2=sent, 3=delivered, 4=read, 5=played
        let newStatus = null;
        if (statusVal === 2 || statusVal === "2" || statusVal === "SERVER_ACK") newStatus = "sent";
        else if (statusVal === 3 || statusVal === "3" || statusVal === "DELIVERY_ACK") newStatus = "delivered";
        else if (statusVal === 4 || statusVal === "4" || statusVal === 5 || statusVal === "5" || statusVal === "READ" || statusVal === "PLAYED") newStatus = "read";

        if (newStatus) {
          try {
            await WaChatMessage.updateOne(
              { messageId: msgId },
              { $set: { status: newStatus } }
            );

            await Message.updateOne(
              { messageId: msgId },
              { $set: { status: newStatus, ...(newStatus === "read" ? { readAt: new Date() } : {}) } }
            ).catch(() => {});

            if (this.io) {
              const statusPayload = {
                sessionId,
                messageId: msgId,
                status: newStatus,
              };
              this.io.to(sessionId).emit("chat:message_status", statusPayload);
              const sessionObj = await SessionModel.findOne({ sessionId }).lean();
              if (sessionObj?.userId) {
                this.io.to(`user:${sessionObj.userId.toString()}`).emit("chat:message_status", statusPayload);
              }
            }
          } catch (e) {}
        }
      }
    });

    // Listen to real-time message receipt updates (read / blue ticks & played receipts)
    sock.ev.on("message-receipt.update", async (receipts) => {
      for (const r of receipts || []) {
        if (!r.key?.id) continue;
        const msgId = r.key.id;
        const receiptData = r.receipt;
        const isRead = !!(receiptData?.readTimestamp || receiptData?.playedTimestamp);
        const isDelivered = !isRead && !!(receiptData?.receiptTimestamp || receiptData?.deliveryTimestamp);
        const newStatus = isRead ? "read" : isDelivered ? "delivered" : null;

        if (newStatus) {
          try {
            await WaChatMessage.updateOne(
              { messageId: msgId },
              { $set: { status: newStatus } }
            );

            await Message.updateOne(
              { messageId: msgId },
              { $set: { status: newStatus, ...(isRead ? { readAt: new Date() } : {}) } }
            ).catch(() => {});

            if (this.io) {
              const statusPayload = {
                sessionId,
                messageId: msgId,
                status: newStatus,
                readTimestamp: receiptData?.readTimestamp || receiptData?.playedTimestamp,
              };
              this.io.to(sessionId).emit("chat:message_status", statusPayload);
              const sessionObj = await SessionModel.findOne({ sessionId }).lean();
              if (sessionObj?.userId) {
                this.io.to(`user:${sessionObj.userId.toString()}`).emit("chat:message_status", statusPayload);
              }
            }
          } catch (e) {}
        }
      }
    });

    // Listen to real-time contact presence updates (typing, recording, online/available)
    sock.ev.on("presence.update", async (presenceUpdate) => {
      try {
        const { id, presences } = presenceUpdate;
        if (!id) return;

        if (this.io) {
          const presencePayload = {
            sessionId,
            chatJid: id,
            presences: presences || {},
          };
          this.io.to(sessionId).emit("chat:presence", presencePayload);
        }

        // Optionally update WaChat isOnline/isTyping flag in database
        if (presences) {
          const isComposing = Object.values(presences).some(
            (p) => p?.lastKnownPresence === "composing" || p?.lastKnownPresence === "recording"
          );
          const isOnline = Object.values(presences).some(
            (p) => p?.lastKnownPresence === "available" || p?.lastKnownPresence === "composing"
          );

          await WaChat.updateOne(
            { sessionId, chatJid: id },
            { $set: { isTyping: isComposing, isOnline: isOnline } }
          ).catch(() => {});
        }
      } catch (err) {
        console.warn("[WA PRESENCE] presence.update error:", err.message);
      }
    });

    // Handle history sync to populate database via ChatSyncService
    sock.ev.on("messaging-history.set", async (history) => {
      console.log(`[WA HISTORY] Received history set: ${history.chats?.length || 0} chats, ${history.messages?.length || 0} messages`);
      await chatSyncService.handleHistorySync(sessionId, history, sock, this.io);
    });

    // Listen to new chats upsert
    sock.ev.on("chats.upsert", async (newChats) => {
      await chatSyncService.handleChatsUpsert(sessionId, newChats, sock, this.io);
    });

    // Listen to chat deletion
    sock.ev.on("chats.delete", async (chatJids) => {
      await chatSyncService.handleChatsDelete(sessionId, chatJids, sock, this.io);
    });

    // Listen to contacts sync
    sock.ev.on("contacts.upsert", async (contacts) => {
      await chatSyncService.handleContactsUpsert(sessionId, contacts, sock, this.io);
    });

    sock.ev.on("contacts.update", async (contacts) => {
      await chatSyncService.handleContactsUpsert(sessionId, contacts, sock, this.io);
    });

    // Listen to newly discovered or joined groups
    sock.ev.on("groups.upsert", async (newGroups) => {
      try {
        console.log(`[WA GROUPS] groups.upsert received ${newGroups?.length || 0} groups for session ${sessionId}`);
        await groupSyncService.handleGroupsUpsert(sessionId, newGroups, sock, this.io);
      } catch (err) {
        console.warn(`[WA GROUPS] groups.upsert error:`, err.message);
      }
    });

    // Keep group metadata and MongoDB fresh on group updates (subject, desc, announce, restrict)
    sock.ev.on("groups.update", async (groupUpdates) => {
      try {
        await groupSyncService.handleGroupsUpdate(sessionId, groupUpdates, sock, this.io);

        for (const update of groupUpdates || []) {
          if (update?.id) {
            try {
              const freshMeta = await sock.groupMetadata(update.id);
              if (freshMeta) {
                if (freshMeta.participants) {
                  await resolveGroupParticipantsLids(sock, freshMeta.participants);
                }
                this.setGroupMetadataInCache(sessionId, update.id, freshMeta);
              }
            } catch (e) {
              this.invalidateGroupMetadataCache(sessionId, update.id);
            }
          }
        }
      } catch (err) {
        console.warn(`[WA GROUPS] groups.update cache refresh error:`, err.message);
      }
    });

    // Real-time group participant additions, removals, promotions, demotions
    sock.ev.on("group-participants.update", async (event) => {
      try {
        await groupSyncService.handleGroupParticipantsUpdate(sessionId, event, sock, this.io);

        if (event?.id) {
          try {
            const freshMeta = await sock.groupMetadata(event.id);
            if (freshMeta) {
              if (freshMeta.participants) {
                await resolveGroupParticipantsLids(sock, freshMeta.participants);
              }
              this.setGroupMetadataInCache(sessionId, event.id, freshMeta);
            }
          } catch (e) {
            this.invalidateGroupMetadataCache(sessionId, event.id);
          }
        }
      } catch (err) {
        console.warn(`[WA GROUPS] group-participants.update error:`, err.message);
      }
    });

    // Listen to chats update (unread count syncing, pin, archive, mute)
    sock.ev.on("chats.update", async (chatUpdates) => {
      await chatSyncService.handleChatsUpdate(sessionId, chatUpdates, sock, this.io);
    });

    return sock;
  }


  async createSession(userId, name, options = {}) {
    const { enableChatView = false, chatPasscode = "" } = options;
    const sessionId = `wa_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const sessionDb = new SessionModel({
      userId: new mongoose.Types.ObjectId(userId),
      name,
      sessionId,
      status: "pending",
      credentials: {},
      chatViewEnabled: !!enableChatView,
    });
    await sessionDb.save();

    const authState = await useMongoAuthState(sessionId);
    const sock = await this.createSocket(sessionId, authState);
    this.sockets.set(sessionId, sock);

    if (this.io)
      this.io.to(sessionId).emit("session:created", { sessionId, name });

    return { sessionId, name, status: "pending" };
  }

  /**
   * Checks if a WhatsApp session is currently active, authenticated, and its WebSocket is open.
   * @param {string} sessionId
   * @returns {boolean}
   */
  isSessionWorking(sessionId) {
    if (!sessionId) return false;
    const sock = this.sockets.get(sessionId);
    if (!sock || sock._isDestroyed) return false;
    const hasUser = !!(sock.user?.id || sock.authState?.state?.creds?.me?.id);
    return !!(hasUser && this.isSocketOpen(sock));
  }

  /**
   * Connects a session ONLY IF it is not already connected and working.
   * Guarantees that an already working session is NEVER reconnected or disturbed.
   * @param {string} sessionId
   * @param {object} options
   */
  async connectSession(sessionId, options = {}) {
    if (this.isSessionWorking(sessionId)) {
      console.log(`[WA CONNECT] Session ${sessionId} is already active and working. Skipping reconnect.`);
      return { sessionId, status: "connected", alreadyWorking: true };
    }
    return this.reconnectSession(sessionId, options);
  }

  /**
   * Connects multiple sessions safely one by one with sequential pacing.
   * @param {string[]} sessionIds
   * @param {object} options
   */
  async connectSessions(sessionIds = [], options = {}) {
    const results = [];
    for (let i = 0; i < sessionIds.length; i++) {
      const sId = sessionIds[i];
      if (this.isSessionWorking(sId)) {
        console.log(`[WA CONNECT] Session ${sId} is already active and working. Skipping.`);
        results.push({ sessionId: sId, status: "connected", alreadyWorking: true });
        continue;
      }
      results.push({ sessionId: sId, status: "connecting" });
      this.reconnectSession(sId, options).catch(() => {});
      if (i < sessionIds.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    return results;
  }

  async reconnectSession(sessionId, options = {}) {
    const { force = false, isRestart = false, hardReset = false } = options;

    // CRITICAL: NEVER reconnect a session that is already working and connected!
    if (!hardReset && this.isSessionWorking(sessionId)) {
      console.log("[WA RECONNECT] Session is already working and connected. Never reconnecting.", { sessionId });
      return { sessionId, status: "connected", alreadyWorking: true };
    }

    if (force) {
      this.reconnectAttempts.delete(sessionId);
      this.reconnectCooldown.delete(sessionId);
    }

    // Safe check: Don't reconnect if already connected and socket is open
    const sock = this.sockets.get(sessionId);
    if (this.isSessionWorking(sessionId)) {
      console.log("[WA RECONNECT] already connected", { sessionId });
      return { sessionId, status: "connected", alreadyWorking: true };
    }

    // Check cooldown - prevent rapid reconnect storms, but NEVER abandon reconnection!
    if (!force && !isRestart && !this.canReconnect(sessionId, force)) {
      const lastReconnect = this.reconnectCooldown.get(sessionId) || 0;
      const remainingMs = Math.max(1000, 15000 - (Date.now() - lastReconnect));
      console.log(
        `[WA RECONNECT] session ${sessionId} in cooldown, scheduling reconnect in ${remainingMs}ms`,
      );
      if (!this.pendingReconnects.has(sessionId)) {
        setTimeout(() => {
          this.reconnectSession(sessionId, { force: true }).catch(() => {});
        }, remainingMs);
      }
      return { sessionId, status: "connecting" };
    }

    // Check retry limit - max 5 attempts (don't limit restarts or force)
    const attempts = this.reconnectAttempts.get(sessionId) || 0;
    if (attempts > 5 && !isRestart && !force) {
      console.log(
        `[WA RECONNECT] too many retries (${attempts}) → pausing session ${sessionId}`,
      );
      await this.handleSessionStateChange(sessionId, "disconnected");
      return;
    }

    // Prevent duplicate reconnects
    if (this.pendingReconnects.has(sessionId)) return;
    this.pendingReconnects.add(sessionId);

    // Update reconnect cooldown timestamp
    this.reconnectCooldown.set(sessionId, Date.now());
    // Increment reconnect attempts if not a restart
    if (!isRestart && !force) {
      this.reconnectAttempts.set(sessionId, attempts + 1);
    }

    try {
      const session = await SessionModel.findOne({ sessionId });
      if (!session) {
        this.pendingReconnects.delete(sessionId);
        return;
      }

      if (this.sockets.has(sessionId)) {
        // Avoid calling sock.end({ reason: "reconnect" }) as it can cause
        // aggressive disconnect behavior; rely on removeSocket() to cleanup.
        try {
          this.removeSocket(sessionId);
        } catch (e) {}
      }

      console.log("[WA RECONNECT] checking creds", { sessionId });
      const hasCreds = await this.validateSessionCredentials(sessionId);
      if (!hasCreds) {
        console.log(`[WA RECONNECT] no valid creds found for ${sessionId}, generating fresh QR code for pairing...`);
        await this.handleSessionStateChange(sessionId, "connecting");
        const authState = await useMongoAuthState(sessionId);
        const sock = await this.createSocket(sessionId, authState);
        this.sockets.set(sessionId, sock);
        return { sessionId, status: "qr" };
      }

      const authState = await useMongoAuthState(sessionId);
      const isValidCreds = this.isValidAuthState(authState);
      if (!isValidCreds && !isRestart && !force) {
        console.warn(
          "[WA RECONNECT] invalid creds detected — preserving files and marking pending",
          { sessionId },
        );
        // Don't delete creds here. A soft transport restart (e.g., 515) or
        // racing writes can result in transient invalid state. Preserve files
        // to allow Baileys to recover; only clear on explicit logout.
        await this.handleSessionStateChange(sessionId, "pending");
        return { sessionId, status: "pending" };
      }

      const sock = await this.createSocket(sessionId, authState);
      this.sockets.set(sessionId, sock);
      await SessionModel.updateOne(
        { sessionId },
        { status: "connecting" },
      ).catch(() => {});
      return { sessionId, status: "connecting" };
    } finally {
      this.pendingReconnects.delete(sessionId);
    }
  }

  /**
   * Restores all saved sessions sequentially one by one on server startup.
   * Staggers connections to prevent CPU/memory overload and WhatsApp rate-limiting.
   */
  async restoreSessions() {
    if (this.isRestoring) {
      console.log("[WA RESTORE] restoreSessions already running, skipping duplicate call.");
      return;
    }
    this.isRestoring = true;

    try {
      const sessions = await SessionModel.find({
        status: { $in: ["connecting", "connected", "disconnected"] },
      }).lean();

      console.log("[WA RESTORE] Boot restore starting...", {
        totalFoundInDb: sessions.length,
        activeSockets: this.sockets.size,
      });

      // Filter only sessions that have valid credentials in MongoDB
      const toRestore = [];
      for (const s of sessions) {
        if (this.isSessionWorking(s.sessionId)) continue;

        const hasCreds = await this.validateSessionCredentials(s.sessionId);
        if (hasCreds) {
          toRestore.push(s);
        } else {
          await this.handleSessionStateChange(s.sessionId, "disconnected");
        }
      }

      console.log(`[WA RESTORE] Found ${toRestore.length} sessions with valid credentials. Restoring sequentially one by one...`);

      // 2.5 second safe spacing between connections for optimal resource and network distribution
      const STAGGER_MS = 2500;

      for (let i = 0; i < toRestore.length; i++) {
        const s = toRestore[i];
        try {
          if (this.isSessionWorking(s.sessionId)) {
            console.log(`[WA RESTORE] (${i + 1}/${toRestore.length}) Session ${s.sessionId} already working. Skipping.`);
            continue;
          }

          console.log(`[WA RESTORE] (${i + 1}/${toRestore.length}) Connecting session ${s.sessionId} (${s.phoneNumber || s.name || 'Account'})...`);

          await this.reconnectSession(s.sessionId, { isRestart: true, force: true });

          // Stagger each session initialization sequentially
          if (i < toRestore.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, STAGGER_MS));
          }
        } catch (e) {
          console.error(`[WA RESTORE] Error restoring session ${s.sessionId}:`, e.message);
        }
      }

      console.log(`[WA RESTORE] Boot restore sequence completed. Active sockets: ${this.sockets.size}`);
    } catch (e) {
      console.error("[WA RESTORE] Global error restoring sessions:", e.message);
    } finally {
      this.isRestoring = false;
    }
  }

  startAutoReconnectWatchdog() {
    if (this._watchdogInterval) clearInterval(this._watchdogInterval);
    this._watchdogInterval = setInterval(async () => {
      // Never interfere with ongoing boot restore sequence
      if (this.isRestoring) {
        return;
      }

      try {
        const sessions = await SessionModel.find({
          status: { $in: ["connecting", "connected"] },
        }).lean();

        for (const s of sessions) {
          // If session is already connected and working in memory, NEVER reconnect it!
          if (this.isSessionWorking(s.sessionId)) {
            // Ensure DB status is synchronized if it had lagged behind
            if (s.status !== "connected") {
              const liveSock = this.sockets.get(s.sessionId);
              const phone = (liveSock?.user?.id || "").split("@")[0].split(":")[0];
              await SessionModel.updateOne(
                { sessionId: s.sessionId },
                { status: "connected", ...(phone ? { phoneNumber: phone } : {}) }
              ).catch(() => {});
            }
            continue;
          }

          // If session is actively in the middle of connecting or reconnecting, do not disrupt it
          const liveSock = this.sockets.get(s.sessionId);
          const isConnecting =
            this.pendingReconnects.has(s.sessionId) ||
            (liveSock && !liveSock._isDestroyed && (liveSock.ws?.isConnecting || !liveSock.user?.id));
          if (isConnecting) continue;

          // Check if credentials exist in MongoDB
          const hasCreds = await this.validateSessionCredentials(s.sessionId);
          if (hasCreds) {
            const attempts = this.reconnectAttempts.get(s.sessionId) || 0;
            if (attempts > 3) continue; // Skip sessions that have repeatedly failed
            const lastAttempt = this.reconnectCooldown.get(s.sessionId) || 0;
            if (Date.now() - lastAttempt > 45000) {
              console.log(`[WA WATCHDOG] Auto-reconnecting inactive session ${s.sessionId}...`);
              await this.reconnectSession(s.sessionId, { force: false }).catch(() => {});
              // Gentle pause between watchdog reconnects
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          }
        }
      } catch (e) {}
    }, 45000);
  }

  getPendingQR(sessionId) {
    return this.pendingQRCodes.get(sessionId) || null;
  }

  getLiveSessionSnapshot(session) {
    if (!session) return null;

    const sessionId = session.sessionId;
    const sock = this.sockets.get(sessionId);
    const isLiveConnected = this.isSessionWorking(sessionId);
    const isReconnecting = this.pendingReconnects.has(sessionId);
    const phoneNumber = isLiveConnected
      ? (sock.user?.id || "").split("@")[0].split(":")[0]
      : session.phoneNumber;

    let status = session.status;
    if (isLiveConnected) {
      status = "connected";
      // Auto-sync DB if it was out of sync
      if (session.status !== "connected" || (!session.phoneNumber && phoneNumber)) {
        SessionModel.updateOne(
          { sessionId },
          { status: "connected", ...(phoneNumber ? { phoneNumber } : {}) }
        ).catch(() => {});
      }
    } else if (isReconnecting) {
      status = "connecting";
    } else if (status === "connected" || status === "connecting") {
      status = "connecting";
      // Auto-rehydrate into memory without triggering a synchronous reconnect storm
      if (!sock && !this.pendingReconnects.has(sessionId) && !this.reconnectCooldown.has(sessionId)) {
        this.reconnectCooldown.set(sessionId, Date.now());
        setTimeout(() => {
          this.connectSession(sessionId).catch(() => {});
        }, 500);
      }
    }

    return {
      sessionId,
      name: session.name,
      status,
      phoneNumber,
      lastConnected: session.lastConnected,
      chatViewEnabled: !!session.chatViewEnabled,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    };
  }

  async getSessionStatus(sessionId) {
    const session = await SessionModel.findOne({ sessionId });
    if (!session) return null;
    const sock = this.sockets.get(sessionId);
    const isLiveConnected = this.isSessionWorking(sessionId);

    if (isLiveConnected && session.status !== "connected") {
      const phone = (sock.user.id || "").split("@")[0].split(":")[0];
      SessionModel.updateOne(
        { sessionId },
        { status: "connected", phoneNumber: phone },
      ).catch(() => {});
      return {
        sessionId: session.sessionId,
        name: session.name,
        status: "connected",
        phoneNumber: phone,
      };
    }

    if (
      !isLiveConnected &&
      ["connected", "connecting"].includes(session.status)
    ) {
      const hasCreds = await this.validateSessionCredentials(sessionId);
      if (hasCreds) {
        this.reconnectSession(sessionId).catch(() => {});
        return {
          sessionId: session.sessionId,
          name: session.name,
          status: "connecting",
          phoneNumber: session.phoneNumber,
        };
      }
    }

    if (!isLiveConnected && session.status === "disconnected") {
      return {
        sessionId: session.sessionId,
        name: session.name,
        status: "disconnected",
        phoneNumber: session.phoneNumber,
      };
    }

    return {
      sessionId: session.sessionId,
      name: session.name,
      status: session.status,
      phoneNumber: session.phoneNumber,
    };
  }

  async emitSessionUpdate(sessionId, statusInfo) {
    if (!this.io) return false;
    try {
      const session = await SessionModel.findOne({ sessionId });
      if (!session) return false;
      const userId = session.userId.toString();
      const payload = {
        sessionId,
        name: session.name,
        status: statusInfo.status || session.status,
        phoneNumber: statusInfo.phoneNumber || session.phoneNumber,
        lastConnected: statusInfo.lastConnected || session.lastConnected,
      };
      this.io.to(`user:${userId}`).emit("session:update", payload);
      this.io.to(sessionId).emit("session:update", payload);
      return true;
    } catch (e) {}

    return false;
  }

  async logoutSession(sessionId) {
    const sock = this.sockets.get(sessionId);
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
      this.removeSocket(sessionId);
      this.clearHeartbeat(sessionId);
    }
    await this.removeSessionFiles(sessionId);
    await this.handleSessionStateChange(sessionId, "disconnected", {
      credentials: {},
    });
    return { success: true };
  }

  async requestPairingCode(sessionId, phoneNumber) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }

    try {
      await waitForSocketOpenWithTimeout(sock);
      // Give a tiny grace period for noise handshake to complete
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      console.log(`[WA PAIRING] Requesting pairing code for session ${sessionId} and phone ${phoneNumber}`);
      const code = await sock.requestPairingCode(phoneNumber);
      return code;
    } catch (err) {
      console.error("[WA PAIRING] Failed to request pairing code:", err);
      throw new Error("Failed to request pairing code: " + err.message);
    }
  }

  async createGroup(sessionId, subject, participants = [], options = {}) {
    console.log(`[WA GROUPS] createGroup requested for sessionId: "${sessionId}". Active socket keys in memory:`, Array.from(this.sockets.keys()));
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    try {
      await waitForSocketOpenWithTimeout(sock);
      const group = await sock.groupCreate(subject, participants);
      
      if (group && group.id) {
        // 1. Edit Group Settings (locked = only admins, unlocked = all members)
        if (options.editGroupSettings !== undefined) {
          const restrictMode = options.editGroupSettings === false ? 'locked' : 'unlocked';
          console.log(`[WA GROUPS] Setting restrictMode for group ${group.id} to ${restrictMode}`);
          await sock.groupSettingUpdate(group.id, restrictMode).catch(err => {
            console.error(`Failed to set restrictMode for group ${group.id}:`, err);
          });
        }

        // 2. Send New Messages (announcement = only admins, not_announcement = all members)
        if (options.sendNewMessages !== undefined) {
          const announceMode = options.sendNewMessages === false ? 'announcement' : 'not_announcement';
          console.log(`[WA GROUPS] Setting announceMode for group ${group.id} to ${announceMode}`);
          await sock.groupSettingUpdate(group.id, announceMode).catch(err => {
            console.error(`Failed to set announceMode for group ${group.id}:`, err);
          });
        }

        // 3. Add Other Members (admin_add = only admins, all_member_add = all members)
        if (options.memberAddMode) {
          console.log(`[WA GROUPS] Setting memberAddMode for group ${group.id} to ${options.memberAddMode}`);
          await sock.groupMemberAddMode(group.id, options.memberAddMode).catch(err => {
            console.error(`Failed to set memberAddMode for group ${group.id}:`, err);
          });
        }

        // 4. Approve New Members (on = admin approval required, off = open)
        if (options.joinApprovalMode) {
          console.log(`[WA GROUPS] Setting joinApprovalMode for group ${group.id} to ${options.joinApprovalMode}`);
          await sock.groupJoinApprovalMode(group.id, options.joinApprovalMode).catch(err => {
            console.error(`Failed to set joinApprovalMode for group ${group.id}:`, err);
          });
        }

        // 5. Send Message History (optional custom node query)
        if (options.sendMessageHistory !== undefined) {
          const historyMode = options.sendMessageHistory === false ? 'off' : 'on';
          console.log(`[WA GROUPS] Setting sendMessageHistory for group ${group.id} to ${historyMode}`);
          try {
            await sock.query({
              tag: 'iq',
              attrs: {
                type: 'set',
                xmlns: 'w:g2',
                to: group.id
              },
              content: [
                {
                  tag: 'member_history_sharing',
                  attrs: {},
                  content: [{ tag: 'history_sharing', attrs: { state: historyMode } }]
                }
              ]
            });
          } catch (err) {
            console.warn(`[WA GROUPS] Custom history_sharing query not supported by server:`, err.message);
          }
        }

        // 6. Invite via Link (optional custom node query)
        if (options.inviteViaLink !== undefined) {
          const inviteMode = options.inviteViaLink === false ? 'off' : 'on';
          console.log(`[WA GROUPS] Setting inviteViaLink for group ${group.id} to ${inviteMode}`);
          try {
            await sock.query({
              tag: 'iq',
              attrs: {
                type: 'set',
                xmlns: 'w:g2',
                to: group.id
              },
              content: [
                {
                  tag: 'allow_member_invite_links',
                  attrs: { enabled: inviteMode }
                }
              ]
            });
          } catch (err) {
            // Silently fall back if the server or Baileys doesn't support the raw node
          }
        }
      }
      
      return group;
    } catch (err) {
      console.error(`[WA GROUPS] Failed to create group "${subject}":`, err);
      throw new Error(`Failed to create group "${subject}": ` + err.message);
    }
  }

  async createMultiAccountGroups(sessionIds = [], subjects = [], rawParticipants = [], maxMembersPerGroup = 100, options = {}) {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new Error("At least one WhatsApp session must be selected.");
    }

    const activeSessions = [];
    for (const sid of sessionIds) {
      const sock = this.sockets.get(sid);
      if (sock) {
        activeSessions.push({ sessionId: sid, sock });
      }
    }

    if (activeSessions.length === 0) {
      throw new Error("None of the selected WhatsApp sessions are currently active. Please check session connections.");
    }

    const coAdminJidsMap = new Map();
    const allCoAdminJids = [];
    for (const item of activeSessions) {
      const jid = item.sock.user?.id ? (item.sock.user.id.split(":")[0] + "@s.whatsapp.net") : null;
      if (jid) {
        coAdminJidsMap.set(item.sessionId, jid);
        allCoAdminJids.push(jid);
      }
    }

    const cleanNumbers = (Array.isArray(rawParticipants) ? rawParticipants : String(rawParticipants || "").split(/[\r\n,;\t]+/))
      .map(p => String(p).replace(/\D/g, "").trim())
      .filter(p => p.length >= 10 && p.length <= 15);

    const participantJids = Array.from(new Set(cleanNumbers)).map(num => `${num}@s.whatsapp.net`);

    const limit = Math.max(1, Math.min(1024, Number(maxMembersPerGroup) || 100));
    
    let groupTasks = [];
    const subjectsArray = Array.isArray(subjects) ? subjects.map(s => String(s).trim()).filter(Boolean) : [String(subjects).trim()];

    if (subjectsArray.length === 1 && participantJids.length > limit) {
      const baseSubject = subjectsArray[0];
      const chunks = [];
      for (let i = 0; i < participantJids.length; i += limit) {
        chunks.push(participantJids.slice(i, i + limit));
      }
      groupTasks = chunks.map((chunk, idx) => ({
        subject: `${baseSubject} ${idx + 1}`,
        participants: chunk
      }));
    } else if (subjectsArray.length > 0) {
      if (participantJids.length > 0) {
        const chunkSize = Math.ceil(participantJids.length / subjectsArray.length);
        groupTasks = subjectsArray.map((subj, idx) => {
          const chunk = participantJids.slice(idx * chunkSize, (idx + 1) * chunkSize);
          return { subject: subj, participants: chunk };
        });
      } else {
        groupTasks = subjectsArray.map(subj => ({ subject: subj, participants: [] }));
      }
    } else {
      throw new Error("At least one group subject is required.");
    }

    const createdGroups = [];
    const errors = [];

    let sessionIndex = 0;
    for (const task of groupTasks) {
      const activeSession = activeSessions[sessionIndex % activeSessions.length];
      sessionIndex++;

      const creatorSock = activeSession.sock;
      const creatorSessionId = activeSession.sessionId;

      try {
        await waitForSocketOpenWithTimeout(creatorSock);

        const creatorJid = coAdminJidsMap.get(creatorSessionId);
        const otherCoAdminJids = allCoAdminJids.filter(j => j !== creatorJid);

        const initialParticipants = Array.from(new Set([...task.participants, ...otherCoAdminJids]));

        const group = await creatorSock.groupCreate(task.subject, initialParticipants);

        if (group && group.id) {
          if (otherCoAdminJids.length > 0) {
            try {
              await creatorSock.groupParticipantsUpdate(group.id, otherCoAdminJids, "promote");
            } catch (pErr) {
              console.warn(`[WA GROUPS] Failed to promote co-admins in group ${group.id}:`, pErr.message);
            }
          }

          if (options.editGroupSettings !== undefined) {
            const restrictMode = options.editGroupSettings === false ? 'locked' : 'unlocked';
            await creatorSock.groupSettingUpdate(group.id, restrictMode).catch(() => {});
          }

          if (options.sendNewMessages !== undefined) {
            const announceMode = options.sendNewMessages === false ? 'announcement' : 'not_announcement';
            await creatorSock.groupSettingUpdate(group.id, announceMode).catch(() => {});
          }

          if (options.memberAddMode) {
            await creatorSock.groupMemberAddMode(group.id, options.memberAddMode).catch(() => {});
          }

          if (options.joinApprovalMode) {
            await creatorSock.groupJoinApprovalMode(group.id, options.joinApprovalMode).catch(() => {});
          }
        }

        createdGroups.push({
          subject: task.subject,
          id: group.id,
          creatorSessionId,
          coAdminsAdded: otherCoAdminJids.length,
          participantsCount: task.participants.length,
          totalParticipantsInGroup: group.participants?.length || initialParticipants.length,
        });

      } catch (err) {
        console.error(`[WA GROUPS] Multi-account group creation failed for "${task.subject}":`, err);
        errors.push({
          subject: task.subject,
          sessionId: creatorSessionId,
          error: err.message
        });
      }
    }

    return {
      success: true,
      created: createdGroups,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  async syncSessionGroups(sessionId, options = {}) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    await waitForSocketOpenWithTimeout(sock);
    return await groupSyncService.syncSessionGroups(sessionId, sock, this.io, options);
  }

  async getGroups(sessionId, options = {}) {
    const { force = false } = options;

    // 1. FAST PATH: Read directly from MongoDB if available & not forced
    if (!force) {
      const cached = await WhatsAppGroup.find({ sessionId }).sort({ participantCount: -1 }).lean();
      if (cached && cached.length > 0) {
        return cached;
      }
    }

    // 2. FALLBACK: Sync from live Baileys socket if DB is empty or force is true
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      return await WhatsAppGroup.find({ sessionId }).sort({ participantCount: -1 }).lean();
    }

    try {
      await this.syncSessionGroups(sessionId, { prune: true });
      return await WhatsAppGroup.find({ sessionId }).sort({ participantCount: -1 }).lean();
    } catch (err) {
      console.warn("[WA GROUPS] Live sync failed, returning cached records:", err.message);
      return await WhatsAppGroup.find({ sessionId }).sort({ participantCount: -1 }).lean();
    }
  }

  async addParticipantsToGroup(sessionId, groupId, rawParticipants = [], options = {}) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found for this WhatsApp account.");
    }
    await waitForSocketOpenWithTimeout(sock);

    const cleanNumbers = (Array.isArray(rawParticipants) ? rawParticipants : String(rawParticipants || "").split(/[\r\n,;\t]+/))
      .map(p => String(p).replace(/\D/g, "").trim())
      .filter(p => p.length >= 10 && p.length <= 15);

    if (cleanNumbers.length === 0) {
      throw new Error("No valid phone numbers (10-15 digits) provided.");
    }

    const participantJids = Array.from(new Set(cleanNumbers)).map(num => `${num}@s.whatsapp.net`);

    console.log(`[WA GROUPS] Safely processing ${participantJids.length} member addition(s) to group ${groupId}`);

    const batchSize = Math.max(1, Math.min(3, Number(options.batchSize) || 2));
    const addedList = [];
    const invitedList = [];
    const failedList = [];

    const sleep = (ms) => new Promise(res => setTimeout(res, ms));

    let inviteCode = null;
    try {
      inviteCode = await sock.groupInviteCode(groupId);
    } catch (e) {
      console.warn(`[WA GROUPS] Could not fetch group invite code for ${groupId}:`, e.message);
    }

    for (let i = 0; i < participantJids.length; i += batchSize) {
      const chunk = participantJids.slice(i, i + batchSize);
      
      if (i > 0) {
        await sleep(2000);
      }

      try {
        const response = await sock.groupParticipantsUpdate(groupId, chunk, "add");

        if (response && typeof response === "object") {
          for (const jid of chunk) {
            const resData = response[jid] || (Array.isArray(response) ? response.find(r => r.jid === jid || r.id === jid) : null);
            const status = resData ? String(resData.status || resData.code || "") : "200";

            if (status === "200" || status === "207") {
              addedList.push(jid);
            } else if (status === "403" || status === "408") {
              if (inviteCode && options.autoSendInviteLink !== false) {
                const inviteUrl = `https://chat.whatsapp.com/${inviteCode}`;
                try {
                  await sock.sendMessage(jid, {
                    text: `Hello! You have been invited to join our WhatsApp group: ${inviteUrl}`
                  });
                  invitedList.push({ jid, reason: "Privacy settings restrict direct addition. Group invite link sent via direct message." });
                } catch (sendErr) {
                  failedList.push({ jid, status, error: "Privacy settings restrict addition and failed to send invite link." });
                }
              } else {
                failedList.push({ jid, status, error: "User privacy settings prohibit adding to groups." });
              }
            } else if (status === "409") {
              addedList.push(jid);
            } else {
              failedList.push({ jid, status, error: resData?.message || `Status code: ${status}` });
            }
          }
        } else {
          addedList.push(...chunk);
        }

      } catch (batchErr) {
        console.warn(`[WA GROUPS] Batch addition failed for ${chunk.join(", ")}:`, batchErr.message);

        if (batchErr.message?.includes("rate-overlimit") || batchErr.message?.includes("429")) {
          console.log(`[WA GROUPS] Rate limit hit. Waiting 3.5s before sending invite fallback...`);
          await sleep(3500);
        }

        for (const jid of chunk) {
          if (inviteCode && options.autoSendInviteLink !== false) {
            try {
              const inviteUrl = `https://chat.whatsapp.com/${inviteCode}`;
              await sock.sendMessage(jid, {
                text: `Hello! You have been invited to join our WhatsApp group: ${inviteUrl}`
              });
              invitedList.push({ jid, reason: "Rate limit reached. Direct invite link sent via message." });
            } catch (msgErr) {
              failedList.push({ jid, error: batchErr.message });
            }
          } else {
            failedList.push({ jid, error: batchErr.message });
          }
        }
      }
    }

    return {
      success: true,
      groupId,
      totalRequested: participantJids.length,
      addedCount: addedList.length,
      invitedCount: invitedList.length,
      failedCount: failedList.length,
      added: addedList,
      invited: invitedList,
      failed: failedList,
      inviteLink: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null
    };
  }

  async getGroupMetadata(sessionId, groupId) {
    const cached = this.getGroupMetadataFromCache(sessionId, groupId);
    if (cached) return cached;

    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    try {
      await waitForSocketOpenWithTimeout(sock);
      const metadata = await sock.groupMetadata(groupId);
      if (metadata && metadata.participants) {
        await resolveGroupParticipantsLids(sock, metadata.participants);
      }
      if (metadata) {
        this.setGroupMetadataInCache(sessionId, groupId, metadata);
      }
      return metadata;
    } catch (err) {
      console.error(`[WA GROUPS] Failed to fetch group metadata for ${groupId}:`, err);
      throw new Error("Failed to fetch group metadata: " + err.message);
    }
  }

  async getGroupInviteLink(sessionId, groupId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    try {
      await waitForSocketOpenWithTimeout(sock);
      const code = await sock.groupInviteCode(groupId);
      return `https://chat.whatsapp.com/${code}`;
    } catch (err) {
      console.error(`[WA GROUPS] Failed to fetch group invite code for ${groupId}:`, err);
      throw new Error("Failed to fetch group invite code: " + err.message);
    }
  }

  extractGroupInviteCode(inviteUrlOrCode) {
    if (!inviteUrlOrCode) return "";
    const str = String(inviteUrlOrCode).trim();
    const match = str.match(/(?:chat\.whatsapp\.com\/(?:invite\/)?)([a-zA-Z0-9_-]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    const clean = str.replace(/[^a-zA-Z0-9_-]/g, "");
    return clean;
  }

  async getGroupInviteInfo(sessionId, inviteUrlOrCode) {
    const code = this.extractGroupInviteCode(inviteUrlOrCode);
    if (!code) {
      throw new Error("Invalid WhatsApp group invite link or code.");
    }

    let sock = sessionId ? this.getSocket(sessionId) : null;
    if (!sock || !this.isSessionWorking(sessionId)) {
      // Pick any connected active socket if provided session is unavailable
      for (const [sId, s] of this.sockets.entries()) {
        if (this.isSessionWorking(sId)) {
          sock = s;
          break;
        }
      }
    }

    if (!sock) {
      throw new Error("No connected WhatsApp account available to inspect group invite link.");
    }

    await waitForSocketOpenWithTimeout(sock, 5000).catch(() => {});
    try {
      const info = await sock.groupGetInviteInfo(code);
      const jid = info.id ? (info.id.includes("@") ? info.id : `${info.id}@g.us`) : "";
      return {
        id: jid,
        subject: info.subject || "WhatsApp Group",
        size: info.size || 0,
        creation: info.creation,
        owner: info.owner,
        desc: info.desc,
        inviteCode: code,
        inviteUrl: `https://chat.whatsapp.com/${code}`,
        code,
      };
    } catch (err) {
      console.error(`[WA GROUPS] Failed to resolve group invite info for ${code}:`, err.message);
      throw new Error(`Failed to resolve group invite link: ${err.message}`);
    }
  }

  async joinGroupViaInvite(sessionId, inviteUrlOrCode) {
    const code = this.extractGroupInviteCode(inviteUrlOrCode);
    if (!code) {
      throw new Error("Invalid WhatsApp group invite link or code.");
    }

    let sock = sessionId ? this.getSocket(sessionId) : null;
    if (!sock || !this.isSessionWorking(sessionId)) {
      for (const [sId, s] of this.sockets.entries()) {
        if (this.isSessionWorking(sId)) {
          sock = s;
          break;
        }
      }
    }

    if (!sock) {
      throw new Error("WhatsApp account is not connected.");
    }

    await waitForSocketOpenWithTimeout(sock, 5000).catch(() => {});

    try {
      let groupJid = null;
      try {
        const info = await sock.groupGetInviteInfo(code);
        if (info?.id) {
          groupJid = info.id.includes("@") ? info.id : `${info.id}@g.us`;
        }
      } catch (e) {}

      const res = await sock.groupAcceptInvite(code);
      const finalJid = res ? (res.includes("@") ? res : `${res}@g.us`) : groupJid;
      console.log(`[WhatsAppService] Session joined group via invite ${code} -> ${finalJid}`);
      return finalJid;
    } catch (err) {
      const errMsg = String(err?.message || err || "").toLowerCase();
      if (
        errMsg.includes("409") ||
        errMsg.includes("already") ||
        errMsg.includes("participant") ||
        errMsg.includes("joined")
      ) {
        console.log(`[WhatsAppService] Session is already a member of group (${code}). Resolving group JID...`);
        try {
          const info = await sock.groupGetInviteInfo(code);
          if (info?.id) {
            return info.id.includes("@") ? info.id : `${info.id}@g.us`;
          }
        } catch (e) {}
        return null;
      }
      console.error(`[WhatsAppService] joinGroupViaInvite error for code ${code}:`, err);
      throw new Error(err.message || "Failed to join group via invite link.");
    }
  }

  async getProfilePictureUrl(sessionId, jid) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return null;
    try {
      await waitForSocketOpenWithTimeout(sock, 4000);
      try {
        const preview = await sock.profilePictureUrl(jid, "preview");
        if (preview) return preview;
      } catch (e1) {
        const full = await sock.profilePictureUrl(jid, "image");
        if (full) return full;
      }
      return null;
    } catch (err) {
      // 404/401/no-profile-photo or socket busy
      return null;
    }
  }

  async getBatchProfilePictures(sessionId, jids) {
    const sock = this.sockets.get(sessionId);
    if (!sock || !Array.isArray(jids) || jids.length === 0) return {};

    await waitForSocketOpenWithTimeout(sock, 4000).catch(() => {});

    const results = {};
    const chunkSize = 8;
    for (let i = 0; i < jids.length; i += chunkSize) {
      const chunk = jids.slice(i, i + chunkSize);
      await Promise.allSettled(
        chunk.map(async (jid) => {
          try {
            let url = null;
            try {
              url = await sock.profilePictureUrl(jid, "preview");
            } catch (e1) {
              url = await sock.profilePictureUrl(jid, "image").catch(() => null);
            }
            if (url) {
              results[jid] = url;
            }
          } catch (e) {}
        })
      );
    }
    return results;
  }

  getSocket(sessionId) {
    return this.sockets.get(sessionId) || null;
  }

  async syncSessionChats(sessionId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) throw new Error("Session is not connected");
    return chatSyncService.syncSessionChats(sessionId, sock, this.io);
  }

  async loadChatHistory(sessionId, chatJid, limit = 50) {
    return [];
  }

  async deleteSession(sessionId) {

    const sock = this.sockets.get(sessionId);
    if (sock) {
      try {
        sock.end({ error: null, reason: "Session deleted" });
      } catch (e) {}
      this.removeSocket(sessionId);
      this.clearHeartbeat(sessionId);
    }
    await this.removeSessionFiles(sessionId);
    await SessionModel.deleteOne({ sessionId }).catch(() => {});
    return { success: true };
  }
}

export default new WhatsAppService();
