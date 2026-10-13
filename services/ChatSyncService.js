import { jidNormalizedUser, downloadMediaMessage } from "@whiskeysockets/baileys";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { WaChat, WaChatMessage, WaContact, WhatsAppSession, CrmContact } from "../models/index.js";
import groupSyncService from "./GroupSyncService.js";
import { handleIncomingMessage } from "./AiAgentService.js";
import { recordIncomingMetaAiMessage, isMetaAiJid, META_AI_NORMALIZED_JID } from "./MetaAiService.js";

/**
 * Normalizes JID to standard WhatsApp format without device identifiers
 */
function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const clean = jidNormalizedUser(jid);
  return clean.replace(/:\d+@/, "@");
}

/**
 * Normalizes phone number from JID or raw string
 */
function extractPhoneNumber(jid) {
  if (!jid) return "";
  const cleaned = normalizeJid(jid);
  return cleaned.replace(/@.*/, "").replace(/:\d+$/, "");
}

/**
 * Safely extracts message body and media from Baileys message object
 */
function unwrapMessage(msg) {
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
    msgContent?.interactiveMessage?.body?.text ||
    msgContent?.interactiveResponseMessage?.body?.text ||
    msgContent?.interactiveMessage?.header?.title ||
    msgContent?.buttonsMessage?.contentText ||
    msgContent?.templateMessage?.hydratedTemplate?.hydratedContentText ||
    msgContent?.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
    msgContent?.imageMessage?.caption ||
    msgContent?.videoMessage?.caption ||
    msgContent?.documentMessage?.caption ||
    msgContent?.buttonsResponseMessage?.selectedButtonId ||
    msgContent?.buttonsResponseMessage?.selectedDisplayText ||
    msgContent?.templateButtonReplyMessage?.selectedId ||
    msgContent?.templateButtonReplyMessage?.selectedDisplayText ||
    msgContent?.listResponseMessage?.title ||
    msgContent?.listResponseMessage?.singleSelectReply?.selectedRowId ||
    rawMsg?.botResponse?.text ||
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

  return { text, mediaType, quotedMessage, msgContent, isProtocolEdit, targetEditMessageId };
}

class ChatSyncService {
  /**
   * Handle full or initial history sync from Baileys 'messaging-history.set'
   */
  async handleHistorySync(sessionId, { chats, contacts, messages, isLatest }, sock, io) {
    try {
      const session = await WhatsAppSession.findOne({ sessionId }).lean();
      if (!session) return;
      const userId = session.userId;

      console.log(
        `[CHAT SYNC] Processing history set for ${sessionId}: ${chats?.length || 0} chats, ${contacts?.length || 0} contacts, ${messages?.length || 0} messages`
      );

      // 1. Process contacts into WaContact
      const contactMap = {};
      if (Array.isArray(contacts) && contacts.length > 0) {
        const contactBulk = [];
        for (const c of contacts) {
          if (!c.id) continue;
          const normJid = normalizeJid(c.id);
          const name = c.name || c.notify || c.verifiedName || "";
          contactMap[normJid] = name;
          contactMap[c.id] = name;

          contactBulk.push({
            updateOne: {
              filter: { userId, sessionId, jid: normJid },
              update: {
                $set: {
                  userId,
                  sessionId,
                  jid: normJid,
                  phoneNumber: extractPhoneNumber(normJid),
                  name: c.name || "",
                  pushName: c.notify || "",
                  verifiedName: c.verifiedName || "",
                },
              },
              upsert: true,
            },
          });
        }
        if (contactBulk.length > 0) {
          await WaContact.bulkWrite(contactBulk, { ordered: false }).catch(() => {});
        }
      }

      // 2. Process chats into WaChat
      if (Array.isArray(chats) && chats.length > 0) {
        const chatBulk = [];
        for (const chat of chats) {
          if (!chat.id) continue;
          const normJid = normalizeJid(chat.id);
          const isGroup = normJid.endsWith("@g.us");
          const phone = extractPhoneNumber(normJid);
          const chatName = chat.name || contactMap[normJid] || (isGroup ? "WhatsApp Group" : `+${phone}`);
          const lastTime = chat.conversationTimestamp
            ? new Date(Number(chat.conversationTimestamp) * 1000)
            : new Date();

          chatBulk.push({
            updateOne: {
              filter: { userId, sessionId, chatJid: normJid },
              update: {
                $set: {
                  isGroup,
                  unreadCount: chat.unreadCount || 0,
                  lastMessageTime: lastTime,
                  isPinned: !!chat.pinned,
                  isArchived: !!chat.archived,
                  isMuted: !!(chat.muteEndTime && Number(chat.muteEndTime) > 0),
                  mutedUntil: chat.muteEndTime ? new Date(Number(chat.muteEndTime) * 1000) : null,
                },
                $setOnInsert: {
                  userId,
                  sessionId,
                  chatJid: normJid,
                  phoneNumber: phone,
                  name: chatName,
                  contactName: chatName,
                  lastMessage: "",
                },
              },
              upsert: true,
            },
          });
        }
        if (chatBulk.length > 0) {
          await WaChat.bulkWrite(chatBulk, { ordered: false }).catch(() => {});
        }
      }

      // 3. Process messages into WaChatMessage
      if (Array.isArray(messages) && messages.length > 0) {
        const msgBulk = [];
        for (const msg of messages) {
          if (!msg.message || !msg.key?.id) continue;
          const isFromMe = !!msg.key.fromMe;
          const rawSender = msg.key.remoteJid;
          if (!rawSender) continue;
          const normJid = normalizeJid(rawSender);
          const participantJid = msg.key.participant ? normalizeJid(msg.key.participant) : (isFromMe ? null : normJid);

          const { text, mediaType, quotedMessage } = unwrapMessage(msg);
          const timestamp = msg.messageTimestamp
            ? new Date(Number(msg.messageTimestamp) * 1000)
            : new Date();

          msgBulk.push({
            updateOne: {
              filter: { messageId: msg.key.id, sessionId },
              update: {
                $set: {
                  userId,
                  sessionId,
                  chatJid: normJid,
                  participantJid,
                  messageId: msg.key.id,
                  text: text || "",
                  direction: isFromMe ? "out" : "in",
                  status: "read",
                  mediaType,
                  ...(quotedMessage ? { quotedMessage } : {}),
                  timestamp,
                },
              },
              upsert: true,
            },
          });
        }

        if (msgBulk.length > 0) {
          await WaChatMessage.bulkWrite(msgBulk, { ordered: false }).catch(() => {});
        }
      }

      console.log(`[CHAT SYNC] History sync completed successfully for ${sessionId}`);
      if (io) {
        io.to(sessionId).emit("chats:synced", { sessionId, lastSyncedAt: new Date() });
        io.to(`user:${userId.toString()}`).emit("chats:synced", { sessionId, lastSyncedAt: new Date() });
      }
    } catch (err) {
      console.error(`[CHAT SYNC] Error in handleHistorySync:`, err.message);
    }
  }

  /**
   * Handle incoming or outgoing live messages from Baileys 'messages.upsert'
   */
  async handleMessagesUpsert(sessionId, messagesData, sock, io) {
    if (!messagesData || !messagesData.messages) return;
    const session = await WhatsAppSession.findOne({ sessionId }).lean();
    if (!session) return;
    const userId = session.userId;

    for (const msg of messagesData.messages) {
      if (!msg.message || !msg.key?.id) continue;

      const isFromMe = !!msg.key.fromMe;
      const rawSenderJid = msg.key.remoteJid;
      if (!rawSenderJid) continue;

      let resolvedSenderJid = normalizeJid(rawSenderJid);
      const isMetaAi = isMetaAiJid(resolvedSenderJid) || isMetaAiJid(rawSenderJid);
      if (isMetaAi) {
        resolvedSenderJid = META_AI_NORMALIZED_JID;
      } else if (rawSenderJid.endsWith("@lid") && sock?.signalRepository?.lidMapping?.getPNForLID) {
        // Resolve @lid if needed
        try {
          const pnJid = await sock.signalRepository.lidMapping.getPNForLID(rawSenderJid);
          if (pnJid) {
            resolvedSenderJid = normalizeJid(pnJid);
          }
        } catch (_) {}
      }

      const participantJid = msg.key.participant ? normalizeJid(msg.key.participant) : (isFromMe ? null : resolvedSenderJid);
      const resolvedPhoneNumber = isMetaAi ? "13135550002" : extractPhoneNumber(resolvedSenderJid);
      const isGroup = resolvedSenderJid.endsWith("@g.us");

      const { text, mediaType, quotedMessage, msgContent, isProtocolEdit, targetEditMessageId } = unwrapMessage(msg);

      // Handle streaming edits (e.g. Meta AI progressive streaming text)
      if (isProtocolEdit && targetEditMessageId) {
        if (text) {
          const updatedDoc = await WaChatMessage.findOneAndUpdate(
            { messageId: targetEditMessageId, sessionId },
            { $set: { text } },
            { new: true }
          );
          if (updatedDoc && io) {
            io.to(sessionId).emit("chat:message_update", {
              sessionId,
              chatJid: updatedDoc.chatJid,
              messageId: targetEditMessageId,
              text,
            });
            io.to(sessionId).emit("chat:message", {
              sessionId,
              chatJid: updatedDoc.chatJid,
              message: updatedDoc,
            });
            io.to(`user:${userId.toString()}`).emit("chat:message", {
              sessionId,
              chatJid: updatedDoc.chatJid,
              message: updatedDoc,
            });
          }
        }
        continue;
      }

      const timestamp = msg.messageTimestamp
        ? new Date(Number(msg.messageTimestamp) * 1000)
        : new Date();

      // Download incoming/outgoing media if present
      let mediaUrl = null;
      let mediaName = null;
      if (mediaType && sock) {
        try {
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { reuploadRequest: sock.updateMediaMessage }
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
          console.warn(`[CHAT SYNC] Media download skipped for msg ${msg.key.id}:`, dlErr.message);
        }
      }

      // 1. Save or update WaChatMessage
      const savedMsg = await WaChatMessage.findOneAndUpdate(
        { messageId: msg.key.id, sessionId },
        {
          $set: {
            userId,
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

      // 2. Update WaChat preview & unread count
      if (isMetaAi) {
        recordIncomingMetaAiMessage(sessionId);
      }

      const contactName = isMetaAi ? "Meta AI" : (msg.pushName || "");
      const lastSnippet = text || (mediaType ? `[${mediaType}]` : "");
      const chatDisplayName = isMetaAi ? "Meta AI" : (contactName || (isGroup ? "WhatsApp Group" : `+${resolvedPhoneNumber}`));

      const chatDoc = await WaChat.findOneAndUpdate(
        { userId, sessionId, chatJid: resolvedSenderJid },
        {
          $set: {
            lastMessage: lastSnippet,
            lastMessageTime: timestamp,
            isGroup,
            phoneNumber: resolvedPhoneNumber,
            ...(isMetaAi ? { name: "Meta AI", contactName: "Meta AI" } : {}),
          },
          $setOnInsert: {
            unreadCount: 0,
            ...(!isMetaAi ? {
              name: chatDisplayName,
              contactName,
            } : {}),
          },
          ...(isFromMe ? {} : { $inc: { unreadCount: 1 } }),
        },
        { upsert: true, new: true }
      );

      // 3. Emit WebSocket events (both to conversation thread and chat listing)
      if (io) {
        const socketPayload = {
          sessionId,
          chatJid: resolvedSenderJid,
          rawJid: rawSenderJid,
          from: resolvedPhoneNumber,
          message: savedMsg,
        };
        io.to(sessionId).emit("chat:message", socketPayload);
        io.to(`user:${userId.toString()}`).emit("chat:message", socketPayload);

        const chatUpdatedPayload = {
          sessionId,
          chatJid: resolvedSenderJid,
          chat: chatDoc,
          lastMessage: lastSnippet,
          lastMessageTime: timestamp,
          unreadCount: chatDoc.unreadCount,
        };
        io.to(sessionId).emit("chat:updated", chatUpdatedPayload);
        io.to(`user:${userId.toString()}`).emit("chat:updated", chatUpdatedPayload);
      }

      // 4. Auto-resolve read receipts for prior outgoing messages
      if (!isFromMe) {
        try {
          const prevOutgoing = await WaChatMessage.find({
            sessionId,
            chatJid: resolvedSenderJid,
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
            if (io) {
              for (const pId of prevIds) {
                const statusPayload = { sessionId, messageId: pId, status: "read" };
                io.to(sessionId).emit("chat:message_status", statusPayload);
                io.to(`user:${userId.toString()}`).emit("chat:message_status", statusPayload);
              }
            }
          }
        } catch (_) {}
      }

      // 5. CRM contact interaction sync
      if (!isGroup && userId) {
        const rawDigits = resolvedPhoneNumber.replace(/[^\d]/g, "").replace(/^0+/, "");
        if (rawDigits) {
          CrmContact.findOneAndUpdate(
            { userId, phone: rawDigits },
            {
              $set: {
                lastInteraction: timestamp || new Date(),
                lastInteractionText: lastSnippet.slice(0, 300),
                chatJid: resolvedSenderJid,
              },
              $inc: { totalConversations: 1 },
            }
          ).exec().catch(() => {});
        }
      }

      // 6. Drip campaigns & AI Agent responses for incoming messages
      if (!isFromMe) {
        const cleanText = text || (mediaType ? `[${mediaType}]` : "");
        dripService
          .handleIncomingReply(userId, sessionId, resolvedSenderJid, cleanText, resolvedPhoneNumber)
          .catch((err) => console.error("[CHAT SYNC] Drip trigger error:", err.message));

        handleIncomingMessage(sessionId, rawSenderJid, text, async (jid, content) => {
          if (sock) {
            await sock.sendPresenceUpdate("composing", jid);
            await new Promise((resolve) => setTimeout(resolve, 1800));
            await sock.sendMessage(jid, { text: content });
            await sock.sendPresenceUpdate("paused", jid);
          }
        }).catch((err) => console.error("[CHAT SYNC] AI Agent error:", err));
      }
    }
  }

  /**
   * Handle Baileys 'chats.upsert'
   */
  async handleChatsUpsert(sessionId, newChats, sock, io) {
    if (!Array.isArray(newChats) || newChats.length === 0) return;
    try {
      const session = await WhatsAppSession.findOne({ sessionId }).lean();
      if (!session) return;
      const userId = session.userId;

      for (const chat of newChats) {
        if (!chat.id) continue;
        const normJid = normalizeJid(chat.id);
        const isGroup = normJid.endsWith("@g.us");
        const phone = extractPhoneNumber(normJid);

        const updated = await WaChat.findOneAndUpdate(
          { userId, sessionId, chatJid: normJid },
          {
            $set: {
              isGroup,
            },
            $setOnInsert: {
              userId,
              sessionId,
              chatJid: normJid,
              phoneNumber: phone,
              name: chat.name || (isGroup ? "WhatsApp Group" : `+${phone}`),
              contactName: chat.name || "",
              lastMessage: "",
              lastMessageTime: new Date(),
              unreadCount: chat.unreadCount || 0,
            },
          },
          { upsert: true, new: true }
        );

        if (io) {
          io.to(sessionId).emit("chat:updated", { sessionId, chatJid: normJid, chat: updated });
        }
      }
    } catch (err) {
      console.warn("[CHAT SYNC] chats.upsert error:", err.message);
    }
  }

  /**
   * Handle Baileys 'chats.update'
   */
  async handleChatsUpdate(sessionId, chatUpdates, sock, io) {
    if (!Array.isArray(chatUpdates) || chatUpdates.length === 0) return;
    try {
      const session = await WhatsAppSession.findOne({ sessionId }).lean();
      if (!session) return;
      const userId = session.userId;

      for (const update of chatUpdates) {
        if (!update.id) continue;
        const normJid = normalizeJid(update.id);
        const patch = {};

        if (typeof update.unreadCount === "number") patch.unreadCount = update.unreadCount;
        if (typeof update.pinned === "boolean") patch.isPinned = update.pinned;
        if (typeof update.archived === "boolean") patch.isArchived = update.archived;
        if (update.muteEndTime !== undefined) {
          patch.isMuted = Number(update.muteEndTime) > 0;
          patch.mutedUntil = update.muteEndTime ? new Date(Number(update.muteEndTime) * 1000) : null;
        }

        if (Object.keys(patch).length > 0) {
          const updated = await WaChat.findOneAndUpdate(
            { userId, sessionId, chatJid: normJid },
            { $set: patch },
            { new: true }
          );

          if (io && updated) {
            io.to(sessionId).emit("chat:updated", { sessionId, chatJid: normJid, chat: updated });
          }
        }
      }
    } catch (err) {
      console.warn("[CHAT SYNC] chats.update error:", err.message);
    }
  }

  /**
   * Handle Baileys 'chats.delete'
   */
  async handleChatsDelete(sessionId, chatJids, sock, io) {
    if (!Array.isArray(chatJids) || chatJids.length === 0) return;
    try {
      const session = await WhatsAppSession.findOne({ sessionId }).lean();
      if (!session) return;
      const userId = session.userId;

      const normJids = chatJids.map((j) => normalizeJid(j));
      await WaChat.deleteMany({ userId, sessionId, chatJid: { $in: normJids } });

      if (io) {
        for (const jid of normJids) {
          io.to(sessionId).emit("chat:deleted", { sessionId, chatJid: jid });
        }
      }
    } catch (err) {
      console.warn("[CHAT SYNC] chats.delete error:", err.message);
    }
  }

  /**
   * Handle Baileys 'contacts.upsert' and 'contacts.update'
   */
  async handleContactsUpsert(sessionId, contacts, sock, io) {
    if (!Array.isArray(contacts) || contacts.length === 0) return;
    try {
      const session = await WhatsAppSession.findOne({ sessionId }).lean();
      if (!session) return;
      const userId = session.userId;

      for (const contact of contacts) {
        if (!contact.id) continue;
        const normJid = normalizeJid(contact.id);
        const name = contact.name || contact.notify || contact.verifiedName || "";
        const phone = extractPhoneNumber(normJid);

        if (name) {
          await WaContact.findOneAndUpdate(
            { userId, sessionId, jid: normJid },
            {
              $set: {
                phoneNumber: phone,
                name: contact.name || "",
                pushName: contact.notify || "",
                verifiedName: contact.verifiedName || "",
              },
            },
            { upsert: true }
          );

          // Update corresponding WaChat display name if not custom
          await WaChat.updateOne(
            { userId, sessionId, chatJid: normJid },
            { $set: { contactName: name } }
          );

          if (io) {
            io.to(sessionId).emit("contact:updated", { sessionId, jid: normJid, name });
          }
        }
      }
    } catch (err) {
      console.warn("[CHAT SYNC] contacts.upsert error:", err.message);
    }
  }

  /**
   * Fast indexed read directly from MongoDB for /api/chats/:sessionId/list.
   * Zero WhatsApp socket latency!
   */
  async getChats(sessionId, userId, options = {}) {
    const { search, tab = "all", page = 1, limit = 50 } = options;

    const query = { userId, sessionId };

    // Tab filter
    if (tab === "direct") {
      query.isGroup = { $ne: true };
      query.chatJid = { $not: /@(g\.us|newsletter|broadcast)$/ };
    } else if (tab === "groups") {
      query.$or = [{ isGroup: true }, { chatJid: /@g\.us$/ }];
      query.chatJid = { $not: /@(newsletter|broadcast)$/ };
    } else if (tab === "unread") {
      query.unreadCount = { $gt: 0 };
    } else {
      // "all" - exclude system newsletters / broadcasts
      query.chatJid = { $not: /@(newsletter|broadcast)$/ };
    }

    // Search query on subject, name, contactName, phone, or chatJid
    if (search && search.trim()) {
      const cleanQ = search.trim();
      const escaped = cleanQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "i");
      query.$or = [
        { name: regex },
        { contactName: regex },
        { phoneNumber: regex },
        { chatJid: regex },
        { lastMessage: regex },
      ];
    }

    const sort = { isPinned: -1, lastMessageTime: -1, updatedAt: -1 };

    let mongoQuery = WaChat.find(query).sort(sort).lean();
    if (limit && Number(limit) > 0) {
      const skip = (Math.max(1, Number(page)) - 1) * Number(limit);
      mongoQuery = mongoQuery.skip(skip).limit(Number(limit));
    }

    const [docs, total] = await Promise.all([
      mongoQuery.exec(),
      WaChat.countDocuments(query),
    ]);

    const formattedChats = docs.map((c) => {
      const isGroup = !!(c.isGroup || c.chatJid.endsWith("@g.us"));
      let cleanPhone = (c.phoneNumber || c.chatJid.replace(/@.*/, "")).replace(/:\d+$/, "");
      let displayName = c.name || c.contactName;

      if (displayName && (displayName.includes(":0") || displayName.includes(":1"))) {
        displayName = "";
      }

      if (!displayName || displayName.trim() === "") {
        if (isGroup) {
          displayName = "WhatsApp Group";
        } else if (cleanPhone && !cleanPhone.includes("@")) {
          displayName = cleanPhone.length === 12 && cleanPhone.startsWith("91")
            ? `+91 ${cleanPhone.slice(2, 7)} ${cleanPhone.slice(7)}`
            : `+${cleanPhone}`;
        } else {
          displayName = c.chatJid.split("@")[0].replace(/:\d+$/, "");
        }
      }

      return {
        _id: c._id,
        chatJid: c.chatJid,
        name: displayName,
        phoneNumber: cleanPhone,
        contactName: c.contactName || "",
        lastMessage: c.lastMessage || (isGroup ? "Group Chat" : ""),
        lastMessageTime: c.lastMessageTime || c.updatedAt,
        unreadCount: c.unreadCount || 0,
        isGroup,
        isPinned: !!c.isPinned,
        pinnedAt: c.pinnedAt || null,
        isMuted: !!c.isMuted,
        mutedUntil: c.mutedUntil || null,
        isArchived: !!c.isArchived,
        profilePictureUrl: c.profilePictureUrl || null,
      };
    });

    return {
      chats: formattedChats,
      total,
      page: Number(page) || 1,
      limit: limit ? Number(limit) : total,
      hasMore: limit ? (Number(page) * Number(limit) < total) : false,
    };
  }

  /**
   * Manual on-demand full chat & contact sync
   */
  async syncSessionChats(sessionId, sock, io) {
    if (!sessionId || !sock) {
      throw new Error("Session is not connected");
    }

    console.log(`[CHAT SYNC] User triggered manual sync for session ${sessionId}`);
    const session = await WhatsAppSession.findOne({ sessionId }).lean();
    if (!session) throw new Error("Session not found in DB");

    // 1. Sync participating groups to WaGroup
    await groupSyncService.syncSessionGroups(sessionId, sock, io, { prune: false }).catch(() => {});

    // 2. Also ensure participating groups are upserted into WaChat
    try {
      if (typeof sock.groupFetchAllParticipating === "function") {
        const groups = await sock.groupFetchAllParticipating();
        const groupList = Object.values(groups || {});
        if (groupList.length > 0) {
          const bulkOps = groupList.map((g) => ({
            updateOne: {
              filter: { userId: session.userId, sessionId, chatJid: g.id },
              update: {
                $set: {
                  name: g.subject || "WhatsApp Group",
                  groupSubject: g.subject || "",
                  groupParticipantCount: g.participants?.length || 0,
                  isGroup: true,
                  updatedAt: new Date(),
                },
                $setOnInsert: {
                  userId: session.userId,
                  sessionId,
                  chatJid: g.id,
                  phoneNumber: g.id.replace(/@.*/, ""),
                  contactName: g.subject || "WhatsApp Group",
                  lastMessage: `${g.participants?.length || 0} participants`,
                  lastMessageTime: new Date(g.creation ? g.creation * 1000 : Date.now()),
                  unreadCount: 0,
                  createdAt: new Date(),
                },
              },
              upsert: true,
            },
          }));
          await WaChat.bulkWrite(bulkOps, { ordered: false });
        }
      }
    } catch (gErr) {
      console.warn("[CHAT SYNC] Error upserting groups to WaChat during manual sync:", gErr.message);
    }

    // Count total chats for this session
    const count = await WaChat.countDocuments({ sessionId, userId: session.userId });

    return { success: true, count, lastSyncedAt: new Date() };
  }
}

export const chatSyncService = new ChatSyncService();
export default chatSyncService;
