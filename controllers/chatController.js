import bcrypt from "bcryptjs";
import { WaChat, WaChatMessage, WhatsAppSession } from "../models/index.js";
import CampaignService from "../services/CampaignService.js";
import WhatsAppService from "../services/WhatsAppService.js";

// ── Verify passcode ────────────────────────────────────────────────────────────
export const verifyPasscode = async (req, res) => {
  try {
    const { passcode, sessionId } = req.body;
    if (!passcode) return res.status(400).json({ error: "Passcode required" });
    if (!sessionId)
      return res.status(400).json({ error: "sessionId is required" });

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    }).select("+chatPasscodeHash chatViewEnabled");

    if (!session) return res.status(404).json({ error: "Session not found" });
    if (!session.chatViewEnabled) {
      return res
        .status(400)
        .json({ error: "Chat view is disabled for this session" });
    }
    if (!session.chatPasscodeHash) {
      return res
        .status(400)
        .json({ error: "Passcode not configured for this session" });
    }

    const match = await bcrypt.compare(
      String(passcode),
      session.chatPasscodeHash,
    );

    if (!match) return res.status(401).json({ error: "Incorrect passcode" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Set / change passcode ──────────────────────────────────────────────────────
export const setPasscode = async (req, res) => {
  try {
    const { currentPasscode, newPasscode, sessionId } = req.body;
    if (!sessionId)
      return res.status(400).json({ error: "sessionId is required" });
    if (!newPasscode || String(newPasscode).length < 4)
      return res
        .status(400)
        .json({ error: "New passcode must be at least 4 characters" });

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    }).select("+chatPasscodeHash chatViewEnabled");

    if (!session) return res.status(404).json({ error: "Session not found" });

    // Verify current passcode
    let currentOk = false;
    if (!session.chatPasscodeHash) {
      currentOk = true;
    } else {
      currentOk = await bcrypt.compare(
        String(currentPasscode || ""),
        session.chatPasscodeHash,
      );
    }
    if (!currentOk)
      return res.status(401).json({ error: "Current passcode is incorrect" });

    session.chatPasscodeHash = await bcrypt.hash(String(newPasscode), 10);
    session.chatViewEnabled = true;
    await session.save();
    res.json({ success: true, message: "Passcode updated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get chat list (inbox) for a session ───────────────────────────────────────
export const getChatList = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const chats = await WaChat.find({ userId: req.user._id, sessionId })
      .sort({ lastMessageTime: -1 })
      .limit(200)
      .lean();

    // Also report sync status so frontend knows if we're still loading
    const sock = WhatsAppService.getSocket(sessionId);
    const isConnected = !!sock?.user?.id;

    res.json({ success: true, chats, isConnected, count: chats.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Get messages for a specific chat ─────────────────────────────────────────
export const getChatMessages = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { limit = 50, before } = req.query;

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const query = { userId: req.user._id, sessionId, chatJid };
    if (before) query.timestamp = { $lt: new Date(before) };

    let messages = await WaChatMessage.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit))
      .lean();

    // If no messages in DB yet, try loading from Baileys in-memory store
    if (messages.length === 0) {
      try {
        const waMessages = await WhatsAppService.loadChatHistory(
          sessionId,
          chatJid,
          50,
        );
        if (waMessages.length > 0) {
          // Save them to DB so next call is instant
          for (const msg of waMessages) {
            if (!msg.message) continue;
            const isFromMe = !!msg.key.fromMe;
            const msgContent =
              msg.message?.viewOnceMessage?.message || msg.message;
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
              await WaChatMessage.findOneAndUpdate(
                { messageId: msg.key.id, sessionId },
                {
                  userId: req.user._id,
                  sessionId,
                  chatJid,
                  messageId: msg.key.id,
                  text: text || "",
                  direction: isFromMe ? "out" : "in",
                  status: "read",
                  mediaType,
                  timestamp,
                },
                { upsert: true, new: true },
              );
            } catch (_) {}
          }
          // Reload from DB after saving
          messages = await WaChatMessage.find(query)
            .sort({ timestamp: -1 })
            .limit(Number(limit))
            .lean();
        }
      } catch (_) {}
    }

    // Mark chat as read
    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { unreadCount: 0 } },
    );

    res.json({ success: true, messages: messages.reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Send message in a chat ─────────────────────────────────────────────────────
export const sendChatMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    // chatJid comes from body to avoid Express dot-truncation in route params
    const { message, chatJid: bodyJid } = req.body;
    const file = req.file;

    const chatJid = bodyJid;
    if (!chatJid) return res.status(400).json({ error: "chatJid is required" });

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "connected")
      return res.status(400).json({ error: "Session not connected" });

    // Resolve the actual recipient JID for sending
    // @lid JIDs are WhatsApp internal IDs — we need the real phone number stored in WaChat
    let sendRecipient;
    if (chatJid.endsWith("@lid")) {
      const waChat = await WaChat.findOne({
        userId: req.user._id,
        sessionId,
        chatJid,
      }).lean();
      if (waChat?.phoneNumber && !waChat.phoneNumber.includes("@")) {
        // Real phone stored — WhatsAppService will append @s.whatsapp.net
        sendRecipient = waChat.phoneNumber;
      } else {
        // No phone mapping found — pass @lid JID directly (Baileys may resolve it)
        sendRecipient = chatJid;
      }
    } else if (chatJid.endsWith("@g.us")) {
      sendRecipient = chatJid; // groups: pass full JID
    } else {
      // @s.whatsapp.net — strip suffix, WhatsAppService will add it back
      sendRecipient = chatJid.replace(/@.*/, "");
    }
    const phoneNumber = sendRecipient;
    let mediaPath = null;
    let mediaType = null;
    let mediaName = null;

    if (file) {
      mediaPath = file.path;
      mediaType = file.mimetype;
      mediaName = file.originalname;
    }

    const result = await CampaignService.sendSingleMessage(
      req.user._id,
      sessionId,
      phoneNumber,
      message || "",
      "",
      mediaPath,
      mediaType,
    );

    // Save outgoing message to WaChatMessage
    const displayText = message || (mediaName ? `[${mediaName}]` : "[file]");
    const msgDoc = await WaChatMessage.create({
      userId: req.user._id,
      sessionId,
      chatJid,
      messageId: result.messageId || `out-${Date.now()}`,
      text: displayText,
      direction: "out",
      status: "sent",
      mediaType: file
        ? file.mimetype.split("/")[0] === "application"
          ? "document"
          : file.mimetype.split("/")[0]
        : null,
      mediaUrl: file ? `/uploads/${file.filename}` : null,
      mediaName: mediaName || null,
      timestamp: new Date(),
    });

    // Update WaChat last message
    await WaChat.findOneAndUpdate(
      { userId: req.user._id, sessionId, chatJid },
      {
        $set: {
          lastMessage: displayText,
          lastMessageTime: new Date(),
        },
      },
      { upsert: true },
    );

    res.json({ success: true, message: msgDoc });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Mark chat as read ──────────────────────────────────────────────────────────
export const markChatRead = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { unreadCount: 0 } },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Force sync — reconnect session so messaging-history.set fires again ────────
export const forceSync = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    // Reconnect triggers messaging-history.set which re-syncs all chats
    await WhatsAppService.reconnectSession(sessionId);
    res.json({
      success: true,
      message: "Reconnecting session — chats will sync in a few seconds",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
