import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WhatsAppSession",
      required: true,
    },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Campaign",
      default: null,
    },
    phoneNumber: {
      type: String,
      required: true,
    },
    contactName: {
      type: String,
      default: "",
    },
    message: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "sent", "failed", "delivered", "read"],
      default: "pending",
    },
    error: {
      type: String,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    readAt: {
      type: Date,
      default: null,
    },
    messageType: {
      type: String,
      enum: ["single", "campaign"],
      default: "single",
    },
  },
  {
    timestamps: true,
  },
);

messageSchema.index({ sessionId: 1, createdAt: -1 });
messageSchema.index({ campaignId: 1 });
messageSchema.index({ phoneNumber: 1 });

export default mongoose.model("Message", messageSchema);
