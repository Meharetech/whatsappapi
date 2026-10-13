import mongoose from "mongoose";

// One document per WhatsApp contact / group per session
const waChatSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true }, // string like wa_xxx
    chatJid: { type: String, required: true }, // 919876543210@s.whatsapp.net or group jid
    phoneNumber: { type: String, default: "" },
    name: { type: String, default: "" },
    contactName: { type: String, default: "" },
    pushName: { type: String, default: "" },
    isGroup: { type: Boolean, default: false },
    groupSubject: { type: String, default: null },
    groupParticipantCount: { type: Number, default: 0 },
    lastMessage: { type: String, default: "" },
    lastMessageTime: { type: Date, default: null },
    unreadCount: { type: Number, default: 0 },
    isOnline: { type: Boolean, default: false },
    isTyping: { type: Boolean, default: false },
    profilePictureUrl: { type: String, default: null },
    isPinned: { type: Boolean, default: false },
    pinnedAt: { type: Date, default: null },
    isMuted: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null },
    isArchived: { type: Boolean, default: false },
    ephemeralExpiration: { type: Number, default: 0 },
  },
  { timestamps: true }
);

waChatSchema.index({ userId: 1, sessionId: 1, chatJid: 1 }, { unique: true });
waChatSchema.index({ userId: 1, sessionId: 1, isPinned: -1, lastMessageTime: -1 });
waChatSchema.index({ userId: 1, sessionId: 1, lastMessageTime: -1 });
waChatSchema.index({ userId: 1, sessionId: 1, isGroup: 1, lastMessageTime: -1 });
waChatSchema.index({ userId: 1, sessionId: 1, unreadCount: 1, lastMessageTime: -1 });
waChatSchema.index({ userId: 1, sessionId: 1, name: 1, phoneNumber: 1 });

export default mongoose.model("WaChat", waChatSchema);
