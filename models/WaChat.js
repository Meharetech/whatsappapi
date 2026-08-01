import mongoose from "mongoose";

// One document per WhatsApp contact per session
const waChatSchema = new mongoose.Schema(
  {
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId:   { type: String, required: true, index: true }, // string like wa_xxx
    chatJid:     { type: String, required: true },               // 919876543210@s.whatsapp.net
    phoneNumber: { type: String, required: true },
    contactName: { type: String, default: "" },
    lastMessage: { type: String, default: "" },
    lastMessageTime: { type: Date, default: null },
    unreadCount: { type: Number, default: 0 },
    isOnline:    { type: Boolean, default: false },
    isTyping:    { type: Boolean, default: false },
  },
  { timestamps: true },
);

waChatSchema.index({ userId: 1, sessionId: 1, chatJid: 1 }, { unique: true });
waChatSchema.index({ userId: 1, sessionId: 1, lastMessageTime: -1 });

export default mongoose.model("WaChat", waChatSchema);
