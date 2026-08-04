import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
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
} from "../models/index.js";
import { handleIncomingMessage } from "./AiAgentService.js";

import { executeFlowOnMessage } from "../controllers/flowExecutionController.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// const SESSIONS_DIR = join(__dirname, "..", "sessions");\
const SESSIONS_DIR =
  process.env.SESSIONS_DIR || join(process.cwd(), "..", "wa-sessions");

console.log(SESSIONS_DIR);

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
 * using Baileys' internal MongoDB-backed mapping.
 */
async function resolveGroupParticipantsLids(sock, participants) {
  if (!participants || !Array.isArray(participants)) return;

  // Extract unique LIDs that do not already have phone numbers resolved
  const lidsToResolve = [...new Set(
    participants
      .filter(p => p.id && p.id.endsWith('@lid') && !p.phoneNumber)
      .map(p => p.id)
  )];

  if (lidsToResolve.length === 0) return;

  const resolvedMappings = {};
  await Promise.all(
    lidsToResolve.map(async (lid) => {
      try {
        const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID(lid);
        if (pnJid) {
          resolvedMappings[lid] = pnJid;
        }
      } catch (err) {
        console.error(`[WA SERVICE] Error resolving JID for LID ${lid}:`, err.message);
      }
    })
  );

  for (const p of participants) {
    if (p.id && resolvedMappings[p.id]) {
      p.phoneNumber = resolvedMappings[p.id];
    }
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

    if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  setSocketIO(io) {
    this.io = io;
  }

  clearHeartbeat(sessionId) {
    const t = this.heartbeats.get(sessionId);
    if (t) clearInterval(t);
    this.heartbeats.delete(sessionId);
  }

  /**
   * Check if a session can reconnect based on cooldown period
   * @param {string} sessionId - The session ID
   * @returns {boolean} - True if reconnect is allowed (15 seconds have passed since last reconnect)
   */
  canReconnect(sessionId) {
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
    this.clearHeartbeat(sessionId);
  }

  /**
   * Properly destroy a socket connection
   * @param {string} sessionId - The session ID
   */
  destroySocket(sessionId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) return;

    try {
      // Close the WebSocket connection
      if (sock.ws && sock.ws.readyState !== sock.ws.CLOSED) {
        sock.ws.close();
      }
      // Remove all event listeners
      if (sock.ev) {
        sock.ev.removeAllListeners();
      }
      // End the socket gracefully
      sock.end({ reason: "destroy" });
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
    if (!nextStatus || currentStatus === nextStatus) {
      return false;
    }

    const liveSock = this.sockets.get(sessionId);
    const isLiveConnected = !!liveSock?.user?.id;

    // A stale reconnect tick should not downgrade a socket that is already live.
    if (currentStatus === "connected" && nextStatus === "connecting") {
      return !isLiveConnected;
    }

    const allowedTransitions = {
      pending: ["connecting", "disconnected", "failed"],
      connecting: ["connected", "disconnected", "failed"],
      connected: ["connecting", "disconnected", "failed"],
      disconnected: ["connecting", "failed"],
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
      return rawValue;
    }

    const digits = rawValue.replace(/\D/g, "");
    if (!digits) {
      throw new Error("Invalid phone number");
    }

    const normalizedDigits = digits.length === 10 ? `91${digits}` : digits;
    return `${normalizedDigits}@s.whatsapp.net`;
  }

  buildMessagePayload(message, mediaPath = null, mediaType = null) {
    if (!mediaPath || !mediaType) {
      return { text: message || "" };
    }

    const mediaBuffer = readFileSync(mediaPath);
    const payload = { mimetype: mediaType };

    if (mediaType.startsWith("image/")) {
      payload.image = mediaBuffer;
      if (message) payload.caption = message;
      return payload;
    }

    if (mediaType.startsWith("video/")) {
      payload.video = mediaBuffer;
      if (message) payload.caption = message;
      return payload;
    }

    if (mediaType.startsWith("audio/")) {
      payload.audio = mediaBuffer;
      payload.ptt = mediaType.includes("ogg");
      return payload;
    }

    payload.document = mediaBuffer;
    payload.fileName = basename(mediaPath);
    if (message) payload.caption = message;
    return payload;
  }

  async sendMessage(
    sessionId,
    phoneNumber,
    message,
    mediaPath = null,
    mediaType = null,
  ) {
    const sock = this.sockets.get(sessionId);

    if (!sock?.user?.id) {
      throw new Error("Session is not connected");
    }

    const jid = this.normalizeJid(phoneNumber);
    const payload = this.buildMessagePayload(message, mediaPath, mediaType);

    return sock.sendMessage(jid, payload);
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

        console.log("[WA HEARTBEAT] tick", {
          sessionId,
          isAuthenticated,
          wsState: liveSock?.ws?.readyState,
          activeSockets: this.sockets.size,
        });

        // If the session is authenticated, treat it as healthy. During
        // initial sync the websocket readyState may bounce; don't trigger
        // reconnects for transient websocket state changes.
        if (isAuthenticated) {
          return;
        }

        console.log("[WA HEARTBEAT] auth lost, reconnecting", { sessionId });

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
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      emitOwnEvents: false,
      fireInitQueries: false,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 15000,
    });

    // Add to active sockets tracking
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

    // Also save initial credentials if they exist
    if (
      authState.state.creds &&
      Object.keys(authState.state.creds).length > 0
    ) {
      console.log("[WA PERSIST] initial credentials detected, saving...", {
        sessionId,
      });
      setTimeout(() => saveCredsWrapper(), 1000); // Save after 1 second
    }

    // QR handling
    sock.ev.on("connection.update", async (update) => {
      const { qr, connection, lastDisconnect } = update;

      if (connection === "connecting") {
        const isValidCreds = await this.validateSessionCredentials(sessionId);

        // Only force QR re-scan if we have invalid credentials AND no QR
        // AND we're not a fresh session (credentials exist but are invalid)
        if (!isValidCreds && !qr) {
          const credsExists = await this.validateSessionCredentials(sessionId);

          // If credentials don't exist, this is a fresh session - wait for QR
          if (!credsExists) {
            console.log(
              "[WA AUTH] fresh session detected, waiting for QR generation",
              { sessionId },
            );
            // Don't remove socket - allow QR to arrive
            return;
          }

          // Credentials exist but are invalid - force re-scan
          console.warn(
            "[WA AUTH] session has invalid creds and no QR pending, forcing QR re-scan",
            { sessionId },
          );
          this.removeSocket(sessionId);
          await this.removeSessionFiles(sessionId);
          await this.handleSessionStateChange(sessionId, "pending");
          return;
        }
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
      }

      if (connection === "close") {
        if (isLoggingOut) {
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

        // CRITICAL: Only delete creds on actual logout, NOT on restart errors
        if (!isValidCreds && attempts > 1) {
          console.warn(
            "[WA AUTH] invalid creds after retries (not restart), forcing QR",
            { sessionId, attempts },
          );
          await this.handleSessionStateChange(sessionId, "pending");
          this.removeSocket(sessionId);
          await this.removeSessionFiles(sessionId);
          return;
        }

        // Handle actual logout: delete creds and mark disconnected
        if (isLogout) {
          console.log("[WA AUTH] actual logout (401 or loggedOut)", {
            sessionId,
          });
          await this.handleSessionStateChange(sessionId, "disconnected");
          this.removeSocket(sessionId);
          await this.removeSessionFiles(sessionId);
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
            const isFromMe = !!msg.key.fromMe;
            const senderJid = msg.key.remoteJid;
            const participantJid = msg.key.participant || (isFromMe ? null : senderJid);
            const msgContent = msg.message?.viewOnceMessage?.message || msg.message;
            const text =
              msgContent?.conversation ||
              msgContent?.extendedTextMessage?.text ||
              msgContent?.imageMessage?.caption ||
              msgContent?.videoMessage?.caption ||
              msgContent?.documentMessage?.caption ||
              "";
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

            try {
              const session = await SessionModel.findOne({ sessionId });
              if (session) {
                await WaChatMessage.findOneAndUpdate(
                  { messageId: msg.key.id, sessionId },
                  {
                    userId: session.userId,
                    sessionId,
                    chatJid: senderJid,
                    participantJid,
                    messageId: msg.key.id,
                    text: text || "",
                    direction: isFromMe ? "out" : "in",
                    status: "read",
                    mediaType,
                    timestamp,
                  },
                  { upsert: true, new: true }
                );

                // Update or create WaChat last message
                const contactName = msg.pushName || "";
                await WaChat.findOneAndUpdate(
                  { userId: session.userId, sessionId, chatJid: senderJid },
                  {
                    $set: {
                      lastMessage: text || (mediaType ? `[${mediaType}]` : ""),
                      lastMessageTime: timestamp,
                    },
                    $setOnInsert: {
                      phoneNumber: senderJid.replace(/@.*/, ""),
                      contactName: contactName,
                    }
                  },
                  { upsert: true }
                );
              }
            } catch (saveErr) {
              console.error("[WA MESSAGE] Failed to save message:", saveErr.message);
            }

            // Hand over to AI Agent Service only if it's not from me
            if (!isFromMe) {
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

    // Handle history sync to populate database
    sock.ev.on("messaging-history.set", async ({ chats, contacts, messages, isLatest }) => {
      console.log(`[WA HISTORY] Received history set: ${messages?.length || 0} messages`);
      try {
        const session = await SessionModel.findOne({ sessionId });
        if (!session) return;

        for (const msg of messages || []) {
          if (!msg.message) continue;
          const isFromMe = !!msg.key.fromMe;
          const senderJid = msg.key.remoteJid;
          const participantJid = msg.key.participant || (isFromMe ? null : senderJid);
          const msgContent = msg.message?.viewOnceMessage?.message || msg.message;
          const text =
            msgContent?.conversation ||
            msgContent?.extendedTextMessage?.text ||
            msgContent?.imageMessage?.caption ||
            msgContent?.videoMessage?.caption ||
            msgContent?.documentMessage?.caption ||
            "";
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

          await WaChatMessage.findOneAndUpdate(
            { messageId: msg.key.id, sessionId },
            {
              userId: session.userId,
              sessionId,
              chatJid: senderJid,
              participantJid,
              messageId: msg.key.id,
              text: text || "",
              direction: isFromMe ? "out" : "in",
              status: "read",
              mediaType,
              timestamp,
            },
            { upsert: true, new: true },
          );
        }
      } catch (err) {
        console.error("[WA HISTORY] Error handling history set:", err.message);
      }
    });

    // Basic message and contact handlers can be added here as needed.

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

  async reconnectSession(sessionId, options = {}) {
    const { force = false, isRestart = false } = options;

    // Safe check: Don't reconnect if already connected
    const sock = this.sockets.get(sessionId);
    if (sock?.ws?.readyState === 1 && sock?.user?.id) {
      console.log("[WA RECONNECT] already connected", { sessionId });
      return;
    }

    // Check cooldown - prevent reconnect if within 15 seconds
    if (!this.canReconnect(sessionId)) {
      console.log(
        `[WA RECONNECT] reconnect blocked by cooldown for session ${sessionId}`,
      );
      return;
    }

    // Check retry limit - max 5 attempts (don't limit restarts)
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
    if (!isRestart) {
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
        console.warn("[WA RECONNECT] no creds found, forcing QR", { sessionId });
        await this.handleSessionStateChange(sessionId, "pending");
        return { sessionId, status: "pending" };
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

  async restoreSessions() {
    try {
      const sessions = await SessionModel.find({
        status: { $in: ["connecting", "connected", "disconnected"] },
      });
      console.log("[WA RESTORE] boot restore starting", {
        sessions: sessions.length,
        activeSockets: this.sockets.size,
      });
      const rehydrateSpacingMs = 1500;

      for (const [index, s] of sessions.entries()) {
        try {
          if (index > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, index * rehydrateSpacingMs),
            );
          }

          const hasCreds = await this.validateSessionCredentials(s.sessionId);
          if (!hasCreds) {
            await this.handleSessionStateChange(s.sessionId, "disconnected");
            continue;
          }
          if (this.sockets.has(s.sessionId)) continue;
          const authState = await useMongoAuthState(s.sessionId);
          const sock = await this.createSocket(s.sessionId, authState);
          this.sockets.set(s.sessionId, sock);
          await this.handleSessionStateChange(s.sessionId, "connecting");
        } catch (e) {}
      }
    } catch (e) {}
  }

  getPendingQR(sessionId) {
    return this.pendingQRCodes.get(sessionId) || null;
  }

  getLiveSessionSnapshot(session) {
    if (!session) return null;

    const sessionId = session.sessionId;
    const sock = this.sockets.get(sessionId);
    const isLiveConnected = !!sock?.user?.id;
    const isReconnecting = this.pendingReconnects.has(sessionId);
    const phoneNumber = isLiveConnected
      ? (sock.user.id || "").split("@")[0].split(":")[0]
      : session.phoneNumber;

    let status = session.status;
    if (isLiveConnected) {
      status = "connected";
    } else if (isReconnecting) {
      status = "connecting";
    } else if (status === "connected" || status === "connecting") {
      status = "disconnected";
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
    const isLiveConnected = !!sock?.user?.id;

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
      const hasCreds = await this.validateSessionCredentials(sessionId);
      if (hasCreds) {
        SessionModel.updateOne({ sessionId }, { status: "connecting" }).catch(
          () => {},
        );
        this.reconnectSession(sessionId).catch(() => {});
        return {
          sessionId: session.sessionId,
          name: session.name,
          status: "connecting",
          phoneNumber: session.phoneNumber,
        };
      }
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
      await sock.waitForSocketOpen();
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
      await sock.waitForSocketOpen();
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

  async getGroups(sessionId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    try {
      await sock.waitForSocketOpen();
      const groups = await sock.groupFetchAllParticipating();
      const groupsArray = Object.values(groups || {});

      // Concurrently resolve all unique participant LIDs to phone numbers
      const allParticipants = groupsArray.flatMap(g => g.participants || []);
      await resolveGroupParticipantsLids(sock, allParticipants);

      const myJidClean = sock.user?.id?.split(':')[0]?.split('@')[0];
      
      const enrichedGroups = groupsArray.map(g => {
        const isAdminOnly = g.announce === true || g.announce === 'true';
        let isMeAdmin = false;
        
        if (g.participants && Array.isArray(g.participants) && myJidClean) {
          const me = g.participants.find(p => {
            const pIdClean = p.id?.split(':')[0]?.split('@')[0];
            return pIdClean === myJidClean;
          });
          if (me && (me.admin === 'admin' || me.admin === 'superadmin')) {
            isMeAdmin = true;
          }
        }

        const canSend = !isAdminOnly || isMeAdmin;

        return {
          ...g,
          isAdminOnly,
          isMeAdmin,
          canSend
        };
      });

      return enrichedGroups;
    } catch (err) {
      console.error("[WA GROUPS] Failed to fetch groups:", err);
      throw new Error("Failed to fetch groups: " + err.message);
    }
  }

  async getGroupMetadata(sessionId, groupId) {
    const sock = this.sockets.get(sessionId);
    if (!sock) {
      throw new Error("Socket connection not found. Please reconnect the session.");
    }
    try {
      await sock.waitForSocketOpen();
      const metadata = await sock.groupMetadata(groupId);
      if (metadata && metadata.participants) {
        await resolveGroupParticipantsLids(sock, metadata.participants);
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
      await sock.waitForSocketOpen();
      const code = await sock.groupInviteCode(groupId);
      return `https://chat.whatsapp.com/${code}`;
    } catch (err) {
      console.error(`[WA GROUPS] Failed to fetch group invite code for ${groupId}:`, err);
      throw new Error("Failed to fetch group invite code: " + err.message);
    }
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
