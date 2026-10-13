import mongoose from "mongoose";

const waChatReminderSchema = new mongoose.Schema(
  {
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId:    { type: String, required: true, index: true },
    chatJid:      { type: String, required: true, index: true },
    contactName:  { type: String, default: "" },
    phoneNumber:  { type: String, default: "" },
    reminderText: { type: String, required: true, trim: true },
    remindAt:     { type: Date, required: true, index: true },
    isTriggered:  { type: Boolean, default: false, index: true },
    isDismissed:  { type: Boolean, default: false },

    // Auto-send WhatsApp message & media fields
    autoSend:     { type: Boolean, default: false },
    sendText:     { type: String, default: "" },
    mediaUrl:     { type: String, default: "" },
    mediaType:    { type: String, default: "" },
    isSent:       { type: Boolean, default: false },
    sentAt:       { type: Date },
    sendError:    { type: String, default: "" },
  },
  { timestamps: true }
);

waChatReminderSchema.index({ userId: 1, sessionId: 1, chatJid: 1 });
waChatReminderSchema.index({ isTriggered: 1, remindAt: 1 });

export default mongoose.model("WaChatReminder", waChatReminderSchema);
