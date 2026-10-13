import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { WaChat, WaChatMessage, WhatsAppSession, WaChatNote, WaChatReminder } from "../models/index.js";
import CampaignService from "../services/CampaignService.js";
import WhatsAppService from "../services/WhatsAppService.js";
import chatSyncService from "../services/ChatSyncService.js";
import { META_AI_JID, META_AI_NORMALIZED_JID, isMetaAiJid, resolveMetaAiBot, onUserSentMessage } from "../services/MetaAiService.js";

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

const lastGroupSyncMap = new Map();

// ── Get chat list (inbox) for a session directly from MongoDB ─────────────────
export const getChatList = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { search, tab = "all", page = 1, limit = 50 } = req.query;

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    }).lean();
    if (!session) return res.status(404).json({ error: "Session not found" });

    const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
    const isConnected = !!sock?.user?.id || session.status === "connected";

    // Fast indexed read directly from MongoDB - zero socket metadata lag
    const result = await chatSyncService.getChats(sessionId, req.user._id, {
      search,
      tab,
      page,
      limit,
    });

    // Auto-sync participating groups into WaChat once if user has 0 chats and is connected
    if (result.total === 0 && isConnected) {
      try {
        const groups = await WhatsAppService.getGroups(sessionId).catch(() => []);
        if (Array.isArray(groups) && groups.length > 0) {
          const bulkOps = groups.map((g) => ({
            updateOne: {
              filter: { userId: req.user._id, sessionId, chatJid: g.id },
              update: {
                $set: {
                  name: g.subject || g.name || "WhatsApp Group",
                  isGroup: true,
                },
                $setOnInsert: {
                  userId: req.user._id,
                  sessionId,
                  chatJid: g.id,
                  phoneNumber: g.id.replace(/@.*/, ""),
                  contactName: g.subject || g.name || "WhatsApp Group",
                  lastMessage: `${g.participants?.length || 0} participants`,
                  lastMessageTime: new Date(g.creation ? g.creation * 1000 : Date.now()),
                  unreadCount: 0,
                },
              },
              upsert: true,
            },
          }));
          if (bulkOps.length > 0) {
            await WaChat.bulkWrite(bulkOps, { ordered: false });
          }
        }
      } catch (_) {}
    }

    // Aggregate notes and reminders counts for the returned chats
    const candidateJids = result.chats.map((c) => c.chatJid);
    let notesMap = new Map();
    let remindersMap = new Map();

    if (candidateJids.length > 0) {
      try {
        const [notesAgg, remindersAgg] = await Promise.all([
          WaChatNote.aggregate([
            { $match: { userId: req.user._id, sessionId, chatJid: { $in: candidateJids } } },
            { $group: { _id: "$chatJid", count: { $sum: 1 } } },
          ]),
          WaChatReminder.aggregate([
            { $match: { userId: req.user._id, sessionId, chatJid: { $in: candidateJids }, isDismissed: false } },
            { $group: { _id: "$chatJid", count: { $sum: 1 } } },
          ]),
        ]);
        if (notesAgg && notesAgg.length > 0) {
          notesMap = new Map(notesAgg.map((n) => [n._id, n.count]));
        }
        if (remindersAgg && remindersAgg.length > 0) {
          remindersMap = new Map(remindersAgg.map((r) => [r._id, r.count]));
        }
      } catch (_) {}
    }

    const formattedChats = result.chats.map((c) => ({
      ...c,
      notesCount: notesMap.get(c.chatJid) || 0,
      remindersCount: remindersMap.get(c.chatJid) || 0,
    }));

    res.json({
      success: true,
      chats: formattedChats,
      isConnected,
      count: formattedChats.length,
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
    });
  } catch (err) {
    console.error("[GET CHAT LIST ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Manual on-demand sync of session chats from WhatsApp ──────────────────────
export const syncSessionChats = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });

    const result = await WhatsAppService.syncSessionChats(sessionId);
    const chatsResult = await chatSyncService.getChats(sessionId, req.user._id, { limit: 100 });

    res.json({
      success: true,
      message: "WhatsApp chats synchronized successfully",
      count: result.count,
      chats: chatsResult.chats,
      lastSyncedAt: new Date(),
    });
  } catch (err) {
    console.error("[SYNC CHATS ERROR]", err);
    res.status(400).json({ success: false, error: err.message });
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

    let normalizedChatJid = chatJid;
    let jidCandidates = [chatJid];
    if (!chatJid.endsWith("@g.us")) {
      normalizedChatJid = chatJid.replace(/:\d+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net");
      const baseNum = normalizedChatJid.replace(/@.*/, "");
      jidCandidates = [
        normalizedChatJid,
        `${baseNum}:0@s.whatsapp.net`,
        `${baseNum}:1@s.whatsapp.net`,
        `${baseNum}:2@s.whatsapp.net`,
        `${baseNum}@c.us`,
      ];
    }

    const query = { userId: req.user._id, sessionId, chatJid: { $in: jidCandidates } };
    if (before) query.timestamp = { $lt: new Date(before) };

    let messages = await WaChatMessage.find(query)
      .sort({ timestamp: -1 })
      .limit(Number(limit))
      .lean();

    // Mark chat as read
    await WaChat.updateMany(
      { userId: req.user._id, sessionId, chatJid: { $in: jidCandidates } },
      { $set: { unreadCount: 0 } },
    );

    // Deduplicate any duplicate records (e.g. legacy msg_ vs real Baileys ID with same text)
    const deduped = [];
    const seenMap = new Map();
    for (const m of messages.reverse()) {
      const id = m.messageId || String(m._id);
      const contentKey = `${m.direction}_${(m.text || m.mediaName || "").trim()}_${Math.floor(new Date(m.timestamp).getTime() / 3000)}`;
      
      if (seenMap.has(id)) continue;
      
      if (m.direction === "out" && seenMap.has(contentKey)) {
        const existingIdx = seenMap.get(contentKey);
        const existing = deduped[existingIdx];
        if (existing && existing.messageId?.startsWith("msg_") && !m.messageId?.startsWith("msg_")) {
          deduped[existingIdx] = m;
          seenMap.set(id, existingIdx);
        }
        continue;
      }
      
      seenMap.set(id, deduped.length);
      if (m.direction === "out") {
        seenMap.set(contentKey, deduped.length);
      }
      deduped.push(m);
    }

    // Auto-resolve any outgoing message tick status:
    // If an incoming message from the contact exists with timestamp >= outgoing message,
    // the outgoing message was seen & read by the recipient (double blue tick)!
    let latestIncomingTime = 0;
    for (const m of deduped) {
      if (m.direction === "in") {
        const t = new Date(m.timestamp).getTime();
        if (t > latestIncomingTime) latestIncomingTime = t;
      }
    }

    if (latestIncomingTime > 0) {
      const toUpdateIds = [];
      for (const m of deduped) {
        if (m.direction === "out" && new Date(m.timestamp).getTime() <= latestIncomingTime && m.status !== "read") {
          m.status = "read";
          if (m.messageId) toUpdateIds.push(m.messageId);
        }
      }
      if (toUpdateIds.length > 0) {
        WaChatMessage.updateMany(
          { messageId: { $in: toUpdateIds } },
          { $set: { status: "read" } }
        ).catch(() => {});
      }
    }

    res.json({ success: true, messages: deduped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Send message in a chat (Supports Text, Media, Voice PTT, Video Note, Location, Contact, Poll, Quoted, Mentions, ViewOnce) ──
export const sendChatMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const {
      message,
      chatJid: bodyJid,
      quotedMessageId,
      quotedText,
      quotedParticipant,
      location,
      contacts,
      poll,
      mentions,
      viewOnce,
      gifPlayback,
      ptv,
      ptt,
      markSeenOnReply,
      replyWithoutSeen,
    } = req.body;
    const file = req.file;

    let chatJid = bodyJid;
    if (!chatJid) return res.status(400).json({ error: "chatJid is required" });
    if (!chatJid.endsWith("@g.us")) {
      chatJid = chatJid.replace(/:\d+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net");
    }

    const session = await WhatsAppSession.findOne({
      sessionId,
      userId: req.user._id,
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (session.status !== "connected")
      return res.status(400).json({ error: "Session not connected" });

    // Resolve the actual recipient JID for sending
    let sendRecipient;
    if (isMetaAiJid(chatJid)) {
      const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
      const botInfo = await resolveMetaAiBot(sock, sessionId);
      sendRecipient = botInfo?.jid || "867051314767696@bot";
    } else if (chatJid.endsWith("@lid")) {
      const waChat = await WaChat.findOne({
        userId: req.user._id,
        sessionId,
        chatJid,
      }).lean();
      if (waChat?.phoneNumber && !waChat.phoneNumber.includes("@")) {
        sendRecipient = waChat.phoneNumber;
      } else {
        sendRecipient = chatJid;
      }
    } else if (chatJid.endsWith("@g.us")) {
      sendRecipient = chatJid;
    } else {
      sendRecipient = chatJid.replace(/@.*/, "").replace(/:\d+$/, "");
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

    let parsedLocation = null;
    if (location) {
      try {
        parsedLocation = typeof location === "string" ? JSON.parse(location) : location;
      } catch (e) {
        parsedLocation = null;
      }
    }

    let parsedContacts = null;
    if (contacts) {
      try {
        parsedContacts = typeof contacts === "string" ? JSON.parse(contacts) : contacts;
      } catch (e) {
        parsedContacts = null;
      }
    }

    let parsedPoll = null;
    if (poll) {
      try {
        parsedPoll = typeof poll === "string" ? JSON.parse(poll) : poll;
      } catch (e) {
        parsedPoll = null;
      }
    }

    let parsedMentions = [];
    if (mentions) {
      try {
        parsedMentions = typeof mentions === "string" ? JSON.parse(mentions) : (Array.isArray(mentions) ? mentions : []);
      } catch (e) {
        parsedMentions = [];
      }
    }

    let quotedOptions = null;
    if (quotedMessageId) {
      quotedOptions = {
        quoted: {
          key: {
            remoteJid: chatJid,
            id: quotedMessageId,
            ...(quotedParticipant ? { participant: quotedParticipant } : {}),
          },
          message: {
            conversation: quotedText || "",
          },
        },
        quotedMessageDoc: {
          messageId: quotedMessageId,
          participant: quotedParticipant || null,
          text: quotedText || null,
        },
      };
    }

    const advancedOptions = {
      ...(quotedOptions || {}),
      location: parsedLocation,
      contacts: parsedContacts,
      poll: parsedPoll,
      mentions: parsedMentions,
      viewOnce: viewOnce === "true" || viewOnce === true,
      gifPlayback: gifPlayback === "true" || gifPlayback === true,
      ptv: ptv === "true" || ptv === true,
      ptt: ptt === "true" || ptt === true,
      fileName: mediaName,
    };

    let result;
    if (parsedLocation || parsedContacts || parsedPoll) {
      // Send via WhatsAppService directly
      result = await WhatsAppService.sendMessage(
        sessionId,
        phoneNumber,
        message || "",
        mediaPath,
        mediaType,
        advancedOptions
      );
    } else {
      result = await CampaignService.sendSingleMessage(
        req.user._id,
        sessionId,
        phoneNumber,
        message || "",
        "",
        mediaPath,
        mediaType,
        advancedOptions
      );
    }

    const isImg = file?.mimetype?.startsWith("image");
    const isVid = file?.mimetype?.startsWith("video");
    const isAud = file?.mimetype?.startsWith("audio");
    let displayText = message || (mediaName ? `[${mediaName}]` : isImg ? "📷 Photo" : isVid ? "🎥 Video" : isAud ? "🎵 Audio" : "");
    if (parsedLocation) displayText = `📍 Location: ${parsedLocation.name || `${parsedLocation.degreesLatitude}, ${parsedLocation.degreesLongitude}`}`;
    if (parsedContacts) displayText = `👤 Contact: ${parsedContacts.displayName || "Contact Card"}`;
    if (parsedPoll) displayText = `📊 Poll: ${parsedPoll.name || "Poll"}`;

    const messageId = result?.messageId || result?.key?.id || (result?._id ? `msg_${result._id}` : `out-${Date.now()}`);

    let dbMediaType = null;
    if (file) {
      dbMediaType = file.mimetype.split("/")[0] === "application" ? "document" : file.mimetype.split("/")[0];
    } else if (parsedLocation) {
      dbMediaType = "location";
    } else if (parsedContacts) {
      dbMediaType = "contact";
    } else if (parsedPoll) {
      dbMediaType = "poll";
    }

    const msgDoc = await WaChatMessage.findOneAndUpdate(
      { sessionId, messageId },
      {
        $set: {
          chatJid,
          text: displayText,
          direction: "out",
          mediaType: dbMediaType,
          ...(file ? {
            mediaUrl: `/uploads/${file.filename}`,
            mediaName: mediaName || null,
          } : {}),
          ...(parsedLocation ? { location: parsedLocation } : {}),
          ...(parsedContacts ? { contacts: Array.isArray(parsedContacts) ? parsedContacts : [parsedContacts] } : {}),
          ...(parsedPoll ? { poll: parsedPoll } : {}),
          ...(parsedMentions.length > 0 ? { mentions: parsedMentions } : {}),
          ...(advancedOptions.viewOnce ? { isViewOnce: true } : {}),
          ...(quotedMessageId ? {
            quotedMessage: {
              messageId: quotedMessageId,
              participant: quotedParticipant || null,
              text: quotedText || null,
            },
          } : {}),
        },
        $setOnInsert: {
          userId: req.user._id,
          timestamp: new Date(),
          status: "sent",
        }
      },
      { upsert: true, new: true }
    );

    // Update WaChat last message
    const cleanPhone = chatJid.replace(/@.*/, "").replace(/:\d+$/, "");
    const isGroup = chatJid.endsWith("@g.us");
    const isMetaAi = isMetaAiJid(chatJid);
    const resolvedContactName = isMetaAi ? "Meta AI" : (req.body.contactName || req.body.name || "").trim();

    const chatUpdateDoc = {
      $set: {
        lastMessage: displayText,
        lastMessageTime: new Date(),
        isGroup,
        phoneNumber: cleanPhone,
        ...(resolvedContactName ? { name: resolvedContactName, contactName: resolvedContactName } : {}),
      },
      $setOnInsert: {
        unreadCount: 0,
        ...(!resolvedContactName ? {
          name: isGroup ? "WhatsApp Group" : `+${cleanPhone}`,
          contactName: isGroup ? "WhatsApp Group" : `+${cleanPhone}`,
        } : {}),
      },
    };

    await WaChat.findOneAndUpdate(
      { userId: req.user._id, sessionId, chatJid },
      chatUpdateDoc,
      { upsert: true }
    );

    // Realtime Socket.IO emission to web inbox
    const activeIo = WhatsAppService.io || req.app.get("io");
    if (activeIo) {
      const socketPayload = {
        sessionId,
        chatJid,
        from: cleanPhone,
        message: msgDoc,
      };
      activeIo.to(sessionId).emit("chat:message", socketPayload);
      if (session.userId) {
        activeIo.to(`user:${session.userId.toString()}`).emit("chat:message", socketPayload);
      }
    }

    // Meta AI Auto-Handling & Fallback
    if (isMetaAiJid(chatJid)) {
      onUserSentMessage(sessionId, req.user._id, displayText, activeIo);
    }

    // Read Receipts on Reply: If markSeenOnReply is enabled and not in stealth mode, send seen status to WhatsApp
    const shouldMarkSeen = (markSeenOnReply === "true" || markSeenOnReply === true) && 
                           replyWithoutSeen !== "true" && replyWithoutSeen !== true;

    if (shouldMarkSeen) {
      try {
        const unreadMsgs = await WaChatMessage.find({
          userId: req.user._id,
          sessionId,
          chatJid,
          direction: "in",
          status: { $ne: "read" },
        })
          .select("messageId participantJid")
          .limit(100)
          .lean();

        if (unreadMsgs.length > 0) {
          const unreadIds = unreadMsgs.map((m) => m.messageId);
          await WaChatMessage.updateMany(
            { userId: req.user._id, sessionId, messageId: { $in: unreadIds } },
            { $set: { status: "read" } },
          );

          const keys = unreadMsgs.map((m) => ({
            remoteJid: chatJid,
            id: m.messageId,
            participant: m.participantJid || undefined,
          }));

          WhatsAppService.markMessagesRead(sessionId, chatJid, keys).catch((err) => {
            console.warn("[WA READ ON REPLY] Error sending read receipt:", err.message);
          });

          await WaChat.updateOne(
            { userId: req.user._id, sessionId, chatJid },
            { $set: { unreadCount: 0 } },
          );

          if (WhatsAppService.io) {
            WhatsAppService.io.to(sessionId).emit("chat:unread_count", { sessionId, chatJid, unreadCount: 0 });
            for (const mId of unreadIds) {
              WhatsAppService.io.to(sessionId).emit("chat:message_status", {
                sessionId,
                messageId: mId,
                status: "read",
              });
            }
          }
        }
      } catch (readErr) {
        console.warn("[WA READ ON REPLY ERROR]", readErr.message);
      }
    }

    res.json({ success: true, message: msgDoc });
  } catch (err) {
    console.error("[SEND CHAT MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Create or update chat contact details ────────────────────────────────────
export const createOrUpdateChat = async (req, res) => {
  try {
    const { sessionId } = req.params;
    let { chatJid, phoneNumber, name, contactName } = req.body;
    if (!chatJid && !phoneNumber) {
      return res.status(400).json({ error: "chatJid or phoneNumber is required" });
    }

    let cleanPhone = (phoneNumber || chatJid || "").replace(/@.*/, "").replace(/:\d+$/, "").replace(/\D/g, "");
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
    let finalChatJid = chatJid || `${cleanPhone}@s.whatsapp.net`;
    if (!finalChatJid.endsWith("@g.us")) {
      finalChatJid = finalChatJid.replace(/:\d+@/, "@").replace(/@c\.us$/, "@s.whatsapp.net");
      cleanPhone = finalChatJid.replace(/@.*/, "").replace(/:\d+$/, "");
    }

    const isMetaAi = isMetaAiJid(finalChatJid) || isMetaAiJid(phoneNumber);
    const savedName = (isMetaAi ? "Meta AI" : (name || contactName || "")).trim();

    const updatedChat = await WaChat.findOneAndUpdate(
      { userId: req.user._id, sessionId, chatJid: finalChatJid },
      {
        $set: {
          ...(savedName ? { name: savedName, contactName: savedName } : {}),
          phoneNumber: cleanPhone,
          isGroup: finalChatJid.endsWith("@g.us"),
        },
        $setOnInsert: {
          lastMessage: isMetaAi ? "Ask Meta AI anything..." : "",
          lastMessageTime: new Date(),
          unreadCount: 0,
        },
      },
      { upsert: true, new: true }
    );

    res.json({ success: true, chat: updatedChat });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Mark chat as read ──────────────────────────────────────────────────────────
export const markChatRead = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;

    // 1. Reset unreadCount in WaChat
    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { unreadCount: 0 } },
    );

    // 2. Find unread incoming messages
    const unreadMsgs = await WaChatMessage.find({
      userId: req.user._id,
      sessionId,
      chatJid,
      direction: "in",
      status: { $ne: "read" },
    })
      .select("messageId participantJid")
      .limit(100)
      .lean();

    if (unreadMsgs.length > 0) {
      const unreadIds = unreadMsgs.map((m) => m.messageId);

      // 3. Mark messages as read in database
      await WaChatMessage.updateMany(
        { userId: req.user._id, sessionId, messageId: { $in: unreadIds } },
        { $set: { status: "read" } },
      );

      // 4. Send read receipts (blue ticks) to WhatsApp via Baileys socket
      const keys = unreadMsgs.map((m) => ({
        remoteJid: chatJid,
        id: m.messageId,
        participant: m.participantJid || undefined,
      }));

      WhatsAppService.markMessagesRead(sessionId, chatJid, keys).catch((err) => {
        console.warn("[WA READ] Error sending read receipt:", err.message);
      });

      // 5. Broadcast real-time status updates to UI
      const io = req.app?.get("io") || WhatsAppService.io;
      if (io) {
        io.to(sessionId).emit("chat:unread_count", { sessionId, chatJid, unreadCount: 0 });
        for (const mId of unreadIds) {
          io.to(sessionId).emit("chat:message_status", {
            sessionId,
            messageId: mId,
            status: "read",
          });
        }
      }
    }

    res.json({ success: true, markedCount: unreadMsgs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Force sync — scan groups, contacts, and update chat list ────────
export const forceSync = syncSessionChats;

// ── Get chat or group profile picture (avatar) ──────────────────────────────
export const getChatProfilePicture = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { refresh } = req.query;

    if (!refresh) {
      const existing = await WaChat.findOne({
        userId: req.user._id,
        sessionId,
        chatJid,
      })
        .select("profilePictureUrl")
        .lean();

      if (existing && existing.profilePictureUrl) {
        return res.json({ success: true, url: existing.profilePictureUrl });
      }
    }

    const url = await WhatsAppService.getProfilePictureUrl(sessionId, chatJid);
    if (url) {
      await WaChat.updateOne(
        { userId: req.user._id, sessionId, chatJid },
        { $set: { profilePictureUrl: url } }
      );
    }

    res.json({ success: true, url: url || null });
  } catch (err) {
    res.json({ success: false, url: null });
  }
};

// ── Batch fetch profile pictures for an array of JIDs ───────────────────────
export const getBatchChatProfilePictures = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jids } = req.body;

    if (!Array.isArray(jids) || jids.length === 0) {
      return res.json({ success: true, avatars: {} });
    }

    const cleanJids = jids.filter(Boolean).slice(0, 100);

    // 1. Check MongoDB cache first
    const cachedChats = await WaChat.find({
      userId: req.user._id,
      sessionId,
      chatJid: { $in: cleanJids },
      profilePictureUrl: { $ne: null },
    })
      .select("chatJid profilePictureUrl")
      .lean();

    const avatars = {};
    cachedChats.forEach((c) => {
      if (c.profilePictureUrl) {
        avatars[c.chatJid] = c.profilePictureUrl;
      }
    });

    // 2. Identify missing JIDs that need live resolution from WhatsApp
    const missingJids = cleanJids.filter((jid) => !avatars[jid]);

    if (missingJids.length > 0) {
      const fetched = await WhatsAppService.getBatchProfilePictures(sessionId, missingJids);
      const bulkOps = [];
      for (const [jid, url] of Object.entries(fetched)) {
        if (url) {
          avatars[jid] = url;
          bulkOps.push({
            updateOne: {
              filter: { userId: req.user._id, sessionId, chatJid: jid },
              update: { $set: { profilePictureUrl: url } },
            },
          });
        }
      }

      if (bulkOps.length > 0) {
        WaChat.bulkWrite(bulkOps, { ordered: false }).catch(() => {});
      }
    }

    res.json({ success: true, avatars });
  } catch (err) {
    console.error("[BATCH AVATAR ERROR]", err);
    res.status(500).json({ error: err.message, avatars: {} });
  }
};

// ── Delete a single chat message ─────────────────────────────────────────────
export const deleteChatMessage = async (req, res) => {
  try {
    const { sessionId, messageId } = req.params;
    const { chatJid } = req.body;

    const query = {
      userId: req.user._id,
      sessionId,
      ...(mongoose.isValidObjectId(messageId)
        ? { $or: [{ messageId }, { _id: messageId }] }
        : { messageId }),
    };

    const msg = await WaChatMessage.findOne(query);
    if (!msg) {
      return res.status(404).json({ error: "Message not found" });
    }

    const actualChatJid = chatJid || msg.chatJid;

    // If it's an outgoing message and session is connected, attempt WhatsApp delete for everyone
    const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
    if (sock?.user?.id && msg.direction === "out" && actualChatJid) {
      try {
        await sock.sendMessage(actualChatJid, {
          delete: {
            remoteJid: actualChatJid,
            fromMe: true,
            id: msg.messageId,
            participant: msg.participantJid || undefined,
          },
        });
      } catch (waErr) {
        console.warn("[WA DELETE] Could not delete message on WhatsApp network:", waErr.message);
      }
    }

    // Delete from MongoDB
    await WaChatMessage.deleteOne({ _id: msg._id });

    // If this was the last message, update the WaChat summary
    const latestMsg = await WaChatMessage.findOne({
      userId: req.user._id,
      sessionId,
      chatJid: actualChatJid,
    }).sort({ timestamp: -1 });

    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid: actualChatJid },
      {
        $set: {
          lastMessage: latestMsg
            ? latestMsg.text || (latestMsg.mediaType ? `[${latestMsg.mediaType}]` : "")
            : "",
          lastMessageTime: latestMsg ? latestMsg.timestamp : new Date(),
        },
      }
    );

    // Emit real-time deletion over Socket.IO
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid: actualChatJid,
        messageId: msg.messageId,
        _id: msg._id,
      };
      WhatsAppService.io.to(sessionId).emit("chat:message_deleted", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:message_deleted", payload);
    }

    res.json({ success: true, messageId: msg.messageId, _id: msg._id });
  } catch (err) {
    console.error("[DELETE MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Delete / Clear an entire chat ───────────────────────────────────────────
export const deleteChat = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;

    // Delete all messages in this conversation
    await WaChatMessage.deleteMany({
      userId: req.user._id,
      sessionId,
      chatJid,
    });

    // Delete the conversation from WaChat
    await WaChat.deleteOne({
      userId: req.user._id,
      sessionId,
      chatJid,
    });

    // Optional Baileys chat delete
    const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
    if (sock?.user?.id) {
      try {
        await sock.chatModify({ delete: true }, chatJid);
      } catch (waErr) {}
    }

    // Emit real-time chat deletion
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid,
      };
      WhatsAppService.io.to(sessionId).emit("chat:chat_deleted", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:chat_deleted", payload);
    }

    res.json({ success: true, chatJid });
  } catch (err) {
    console.error("[DELETE CHAT ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Batch delete multiple chats ────────────────────────────────────────────
export const deleteMultipleChats = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJids } = req.body;

    if (!Array.isArray(chatJids) || chatJids.length === 0) {
      return res.status(400).json({ error: "chatJids array is required" });
    }

    // Delete all messages in these conversations
    await WaChatMessage.deleteMany({
      userId: req.user._id,
      sessionId,
      chatJid: { $in: chatJids },
    });

    // Delete conversations from WaChat
    await WaChat.deleteMany({
      userId: req.user._id,
      sessionId,
      chatJid: { $in: chatJids },
    });

    // Optional Baileys chat delete in background
    const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
    if (sock?.user?.id) {
      for (const jid of chatJids) {
        try {
          await sock.chatModify({ delete: true }, jid);
        } catch (e) {}
      }
    }

    // Emit real-time batch deletion
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJids,
      };
      WhatsAppService.io.to(sessionId).emit("chat:chats_batch_deleted", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:chats_batch_deleted", payload);
    }

    res.json({ success: true, count: chatJids.length, chatJids });
  } catch (err) {
    console.error("[BATCH DELETE CHATS ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Batch delete multiple messages in a chat ───────────────────────────────
export const deleteMultipleMessages = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { messageIds, chatJid } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: "messageIds array is required" });
    }

    const validObjectIds = messageIds.filter((id) => mongoose.isValidObjectId(id));
    const queryFilter = {
      userId: req.user._id,
      sessionId,
      ...(validObjectIds.length > 0
        ? { $or: [{ messageId: { $in: messageIds } }, { _id: { $in: validObjectIds } }] }
        : { messageId: { $in: messageIds } }),
    };

    // Find the messages to handle Baileys delete for outgoing
    const messagesToDelete = await WaChatMessage.find(queryFilter).lean();

    const actualChatJid = chatJid || messagesToDelete[0]?.chatJid;

    const sock = WhatsAppService.getSocket ? WhatsAppService.getSocket(sessionId) : null;
    if (sock?.user?.id && actualChatJid) {
      for (const msg of messagesToDelete) {
        if (msg.direction === "out") {
          try {
            await sock.sendMessage(actualChatJid, {
              delete: {
                remoteJid: actualChatJid,
                fromMe: true,
                id: msg.messageId,
                participant: msg.participantJid || undefined,
              },
            });
          } catch (e) {}
        }
      }
    }

    // Delete from MongoDB
    const deleteResult = await WaChatMessage.deleteMany(queryFilter);

    // Update WaChat last message
    if (actualChatJid) {
      const latestMsg = await WaChatMessage.findOne({
        userId: req.user._id,
        sessionId,
        chatJid: actualChatJid,
      }).sort({ timestamp: -1 });

      await WaChat.updateOne(
        { userId: req.user._id, sessionId, chatJid: actualChatJid },
        {
          $set: {
            lastMessage: latestMsg
              ? latestMsg.text || (latestMsg.mediaType ? `[${latestMsg.mediaType}]` : "")
              : "",
            lastMessageTime: latestMsg ? latestMsg.timestamp : new Date(),
          },
        }
      );
    }

    // Emit real-time batch deletion
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid: actualChatJid,
        messageIds,
      };
      WhatsAppService.io.to(sessionId).emit("chat:messages_batch_deleted", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:messages_batch_deleted", payload);
    }

    res.json({ success: true, count: deleteResult.deletedCount, messageIds });
  } catch (err) {
    console.error("[BATCH DELETE MESSAGES ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Pin / Unpin Chat ─────────────────────────────────────────────────────────
export const togglePinChat = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { isPinned } = req.body;

    const chat = await WaChat.findOne({
      userId: req.user._id,
      sessionId,
      chatJid,
    });

    if (!chat) return res.status(404).json({ error: "Chat not found" });

    const newPinned = typeof isPinned === "boolean" ? isPinned : !chat.isPinned;

    chat.isPinned = newPinned;
    chat.pinnedAt = newPinned ? new Date() : null;
    await chat.save();

    // Realtime Socket.IO emission so all connected tabs/devices update immediately
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid,
        isPinned: chat.isPinned,
        pinnedAt: chat.pinnedAt,
      };
      WhatsAppService.io.to(sessionId).emit("chat:pinned", payload);
      if (req.user?._id) {
        WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:pinned", payload);
      }
    }

    res.json({
      success: true,
      chatJid,
      isPinned: chat.isPinned,
      pinnedAt: chat.pinnedAt,
    });
  } catch (err) {
    console.error("[TOGGLE PIN CHAT ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Notes Management ─────────────────────────────────────────────────────────
export const getChatNotes = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const notes = await WaChatNote.find({
      userId: req.user._id,
      sessionId,
      chatJid,
    }).sort({ createdAt: -1 }).lean();
    res.json({ success: true, notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const addChatNote = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { note } = req.body;
    if (!note || !note.trim()) {
      return res.status(400).json({ error: "Note content is required" });
    }

    const created = await WaChatNote.create({
      userId: req.user._id,
      sessionId,
      chatJid,
      note: note.trim(),
    });

    res.json({ success: true, note: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteChatNote = async (req, res) => {
  try {
    const { noteId } = req.params;
    await WaChatNote.deleteOne({ _id: noteId, userId: req.user._id });
    res.json({ success: true, noteId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Reminders / Alert Message Management ────────────────────────────────────
export const getChatReminders = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const reminders = await WaChatReminder.find({
      userId: req.user._id,
      sessionId,
      chatJid,
    }).sort({ remindAt: 1 }).lean();
    res.json({ success: true, reminders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const createChatReminder = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { reminderText, remindAt, contactName, phoneNumber, autoSend, sendText } = req.body;

    if (!reminderText || !reminderText.trim()) {
      return res.status(400).json({ error: "Reminder message text is required" });
    }
    if (!remindAt) {
      return res.status(400).json({ error: "Date and time (remindAt) is required" });
    }

    const remindDate = new Date(remindAt);
    if (isNaN(remindDate.getTime())) {
      return res.status(400).json({ error: "Invalid date format for remindAt" });
    }

    let mediaUrl = req.body.mediaUrl || "";
    let mediaType = req.body.mediaType || "";

    if (req.file) {
      mediaUrl = `/uploads/${req.file.filename}`;
      mediaType = req.file.mimetype;
    }

    const isAutoSend = autoSend === "true" || autoSend === true;

    const created = await WaChatReminder.create({
      userId: req.user._id,
      sessionId,
      chatJid,
      contactName: contactName || "",
      phoneNumber: phoneNumber || chatJid.replace(/@.*/, ""),
      reminderText: reminderText.trim(),
      remindAt: remindDate,
      autoSend: isAutoSend,
      sendText: (sendText || reminderText).trim(),
      mediaUrl,
      mediaType,
      isTriggered: false,
      isDismissed: false,
    });

    res.json({ success: true, reminder: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteChatReminder = async (req, res) => {
  try {
    const { reminderId } = req.params;
    await WaChatReminder.deleteOne({ _id: reminderId, userId: req.user._id });
    res.json({ success: true, reminderId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const dismissChatReminder = async (req, res) => {
  try {
    const { reminderId } = req.params;
    const updated = await WaChatReminder.findOneAndUpdate(
      { _id: reminderId, userId: req.user._id },
      { $set: { isDismissed: true } },
      { new: true }
    );
    res.json({ success: true, reminder: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── React to a Message ───────────────────────────────────────────────────────
export const reactToMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid, messageId, messageKey, emoji } = req.body;

    if (!chatJid || (!messageId && !messageKey)) {
      return res.status(400).json({ error: "chatJid and messageId/messageKey are required" });
    }

    let key = messageKey;
    if (!key && messageId) {
      const msg = await WaChatMessage.findOne({
        userId: req.user._id,
        sessionId,
        messageId,
      }).lean();

      if (msg) {
        key = {
          remoteJid: chatJid,
          fromMe: msg.direction === "out",
          id: msg.messageId,
          participant: msg.participantJid || undefined,
        };
      } else {
        key = {
          remoteJid: chatJid,
          id: messageId,
        };
      }
    }

    // Send reaction to WhatsApp
    await WhatsAppService.sendReaction(sessionId, chatJid, key, emoji || "");

    // Update in MongoDB
    const targetMsgId = key.id || messageId;
    const existingMsg = await WaChatMessage.findOne({
      userId: req.user._id,
      sessionId,
      messageId: targetMsgId,
    });

    if (existingMsg) {
      let reactions = existingMsg.reactions || [];
      if (!emoji) {
        // Remove reaction
        reactions = reactions.filter((r) => r.by !== "me");
      } else {
        // Update / Add reaction
        const idx = reactions.findIndex((r) => r.by === "me");
        if (idx >= 0) {
          reactions[idx].emoji = emoji;
        } else {
          reactions.push({ emoji, by: "me" });
        }
      }
      existingMsg.reactions = reactions;
      await existingMsg.save();
    }

    // Broadcast reaction update
    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid,
        messageId: targetMsgId,
        emoji: emoji || "",
        by: "me",
      };
      WhatsAppService.io.to(sessionId).emit("chat:reaction", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:reaction", payload);
    }

    res.json({ success: true, messageId: targetMsgId, emoji: emoji || "" });
  } catch (err) {
    console.error("[REACT TO MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Pin / Unpin a Message ────────────────────────────────────────────────────
export const pinChatMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid, messageId, messageKey, type = 1, durationSeconds = 86400 } = req.body;

    if (!chatJid || (!messageId && !messageKey)) {
      return res.status(400).json({ error: "chatJid and messageId/messageKey are required" });
    }

    let key = messageKey;
    if (!key && messageId) {
      const msg = await WaChatMessage.findOne({
        userId: req.user._id,
        sessionId,
        messageId,
      }).lean();

      if (msg) {
        key = {
          remoteJid: chatJid,
          fromMe: msg.direction === "out",
          id: msg.messageId,
          participant: msg.participantJid || undefined,
        };
      } else {
        key = { remoteJid: chatJid, id: messageId };
      }
    }

    // Send pin update to WhatsApp
    await WhatsAppService.pinMessage(sessionId, chatJid, key, Number(type), Number(durationSeconds));

    const targetMsgId = key.id || messageId;
    const isPinned = Number(type) === 1;
    const pinnedUntil = isPinned ? new Date(Date.now() + Number(durationSeconds) * 1000) : null;

    await WaChatMessage.updateOne(
      { userId: req.user._id, sessionId, messageId: targetMsgId },
      { $set: { isPinned, pinnedUntil } }
    );

    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid,
        messageId: targetMsgId,
        isPinned,
        pinnedUntil,
      };
      WhatsAppService.io.to(sessionId).emit("chat:message_pinned", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:message_pinned", payload);
    }

    res.json({ success: true, messageId: targetMsgId, isPinned, pinnedUntil });
  } catch (err) {
    console.error("[PIN MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Star / Unstar Message ────────────────────────────────────────────────────
export const starChatMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid, messageId, fromMe = false, star = true } = req.body;

    if (!chatJid || !messageId) {
      return res.status(400).json({ error: "chatJid and messageId are required" });
    }

    await WhatsAppService.starMessage(sessionId, chatJid, messageId, Boolean(fromMe), Boolean(star));

    await WaChatMessage.updateOne(
      { userId: req.user._id, sessionId, messageId },
      { $set: { isStarred: Boolean(star) } }
    );

    if (WhatsAppService.io) {
      const payload = {
        sessionId,
        chatJid,
        messageId,
        isStarred: Boolean(star),
      };
      WhatsAppService.io.to(sessionId).emit("chat:message_starred", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:message_starred", payload);
    }

    res.json({ success: true, messageId, isStarred: Boolean(star) });
  } catch (err) {
    console.error("[STAR MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Send Presence Update (composing, recording, available, unavailable) ───────
export const sendPresenceUpdate = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { chatJid, type = "composing" } = req.body;

    if (!chatJid) {
      return res.status(400).json({ error: "chatJid is required" });
    }

    await WhatsAppService.sendPresence(sessionId, chatJid, type);
    res.json({ success: true, presence: type });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Subscribe to chat presence (online / typing updates) ──────────────────────
export const subscribeChatPresence = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;

    if (!chatJid) {
      return res.status(400).json({ error: "chatJid is required" });
    }

    await WhatsAppService.subscribePresence(sessionId, chatJid);
    res.json({ success: true, subscribed: chatJid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// ── Mute / Unmute Chat ───────────────────────────────────────────────────────
export const muteChat = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { durationMs } = req.body; // null to unmute, or ms number (8h, 7d, etc.)

    await WhatsAppService.muteChat(sessionId, chatJid, durationMs ?? null);

    const isMuted = durationMs !== null && durationMs !== undefined;
    const mutedUntil = isMuted ? new Date(Date.now() + Number(durationMs)) : null;

    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { isMuted, mutedUntil } }
    );

    if (WhatsAppService.io) {
      const payload = { sessionId, chatJid, isMuted, mutedUntil };
      WhatsAppService.io.to(sessionId).emit("chat:muted", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:muted", payload);
    }

    res.json({ success: true, chatJid, isMuted, mutedUntil });
  } catch (err) {
    console.error("[MUTE CHAT ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Archive / Unarchive Chat ─────────────────────────────────────────────────
export const archiveChat = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { archive = true } = req.body;

    await WhatsAppService.archiveChat(sessionId, chatJid, Boolean(archive));

    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { isArchived: Boolean(archive) } }
    );

    if (WhatsAppService.io) {
      const payload = { sessionId, chatJid, isArchived: Boolean(archive) };
      WhatsAppService.io.to(sessionId).emit("chat:archived", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:archived", payload);
    }

    res.json({ success: true, chatJid, isArchived: Boolean(archive) });
  } catch (err) {
    console.error("[ARCHIVE CHAT ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Disappearing Messages Toggle / Timer ─────────────────────────────────────
export const setChatDisappearing = async (req, res) => {
  try {
    const { sessionId, chatJid } = req.params;
    const { ephemeralExpiration } = req.body; // 0, 86400, 604800, 7776000

    await WhatsAppService.setDisappearingMessages(sessionId, chatJid, ephemeralExpiration);

    await WaChat.updateOne(
      { userId: req.user._id, sessionId, chatJid },
      { $set: { ephemeralExpiration: Number(ephemeralExpiration) || 0 } }
    );

    if (WhatsAppService.io) {
      const payload = { sessionId, chatJid, ephemeralExpiration: Number(ephemeralExpiration) || 0 };
      WhatsAppService.io.to(sessionId).emit("chat:disappearing_changed", payload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:disappearing_changed", payload);
    }

    res.json({ success: true, chatJid, ephemeralExpiration: Number(ephemeralExpiration) || 0 });
  } catch (err) {
    console.error("[DISAPPEARING ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Forward Message ─────────────────────────────────────────────────────────
export const forwardChatMessage = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { targetJid, messageId } = req.body;

    if (!targetJid || !messageId) {
      return res.status(400).json({ error: "targetJid and messageId are required" });
    }

    const sourceMsg = await WaChatMessage.findOne({
      userId: req.user._id,
      sessionId,
      messageId,
    }).lean();

    if (!sourceMsg) {
      return res.status(404).json({ error: "Source message not found" });
    }

    const sendRes = await WhatsAppService.sendMessage(
      sessionId,
      targetJid,
      sourceMsg.text || "",
      sourceMsg.mediaUrl ? `.${sourceMsg.mediaUrl}` : null,
      sourceMsg.mediaType,
      {
        forward: true,
      }
    );

    const newMsgId = sendRes?.messageId || sendRes?.key?.id || `fwd-${Date.now()}`;

    const forwardedDoc = await WaChatMessage.create({
      userId: req.user._id,
      sessionId,
      chatJid: targetJid,
      messageId: newMsgId,
      text: sourceMsg.text,
      mediaType: sourceMsg.mediaType,
      mediaUrl: sourceMsg.mediaUrl,
      mediaName: sourceMsg.mediaName,
      direction: "out",
      status: "sent",
      isForwarded: true,
      timestamp: new Date(),
    });

    await WaChat.findOneAndUpdate(
      { userId: req.user._id, sessionId, chatJid: targetJid },
      {
        $set: {
          lastMessage: sourceMsg.text || (sourceMsg.mediaType ? `[${sourceMsg.mediaType}]` : ""),
          lastMessageTime: new Date(),
        },
      },
      { upsert: true }
    );

    if (WhatsAppService.io) {
      const socketPayload = {
        sessionId,
        chatJid: targetJid,
        from: targetJid.replace(/@.*/, ""),
        message: forwardedDoc,
      };
      WhatsAppService.io.to(sessionId).emit("chat:message", socketPayload);
      WhatsAppService.io.to(`user:${req.user._id.toString()}`).emit("chat:message", socketPayload);
    }

    res.json({ success: true, message: forwardedDoc });
  } catch (err) {
    console.error("[FORWARD MESSAGE ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};

// ── Check if phone number exists on WhatsApp ─────────────────────────────────
export const checkNumbersOnWhatsApp = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { jids } = req.body;

    if (!jids) {
      return res.status(400).json({ error: "jids array or phone string is required" });
    }

    const results = await WhatsAppService.checkOnWhatsApp(sessionId, jids);
    res.json({ success: true, results });
  } catch (err) {
    console.error("[CHECK WHATSAPP ERROR]", err);
    res.status(500).json({ error: err.message });
  }
};
