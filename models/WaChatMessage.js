import mongoose from "mongoose";

const waChatMessageSchema = new mongoose.Schema(
  {
    userId:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId:  { type: String, required: true, index: true },
    chatJid:    { type: String, required: true, index: true },
    participantJid: { type: String, default: null }, // JID of the user who sent the message (in groups)
    messageId:  { type: String, required: true }, // Baileys message ID or our generated ID
    text:       { type: String, default: "" },
    direction:  { type: String, enum: ["in", "out"], required: true }, // in=received, out=sent
    status:     { type: String, enum: ["pending", "sent", "delivered", "read", "failed"], default: "sent" },
    mediaType:  { type: String, default: null }, // null | image | video | document | audio
    mediaUrl:   { type: String, default: null }, // relative path /uploads/...
    mediaName:  { type: String, default: null },
    timestamp:  { type: Date, required: true },
  },
  { timestamps: true },
);

waChatMessageSchema.index({ userId: 1, sessionId: 1, chatJid: 1, timestamp: -1 });
waChatMessageSchema.index({ messageId: 1, sessionId: 1 }, { unique: true });

export default mongoose.model("WaChatMessage", waChatMessageSchema);
