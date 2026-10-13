import mongoose from "mongoose";

const dripRecipientLogSchema = new mongoose.Schema(
  {
    stepIndex: { type: Number, required: true },
    stepName: { type: String, default: "" },
    sentAt: { type: Date, default: Date.now },
    executedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["sent", "failed"],
      default: "sent",
    },
    messagePreview: { type: String, default: "" },
    mediaUrl: { type: String, default: null },
    mediaType: { type: String, default: null },
    deliveryStatus: { type: String, default: "sent" },
    error: { type: String, default: null },
  },
  { _id: true, timestamps: true }
);

const dripRecipientSchema = new mongoose.Schema(
  {
    dripCampaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DripCampaign",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true },
    phone: { type: String, required: true, trim: true },
    contactName: { type: String, default: "" },
    chatJid: { type: String, required: true, index: true },
    currentStep: { type: Number, default: 0 }, // 0 = enrolled, 1 = step 1 sent, etc.
    nextStepIndex: { type: Number, default: 1 },
    nextStepPreview: { type: String, default: "" },
    nextStepDelayText: { type: String, default: "" },
    status: {
      type: String,
      enum: ["active", "paused", "replied", "completed", "failed"],
      default: "active",
      index: true,
    },
    enrolledAt: { type: Date, default: Date.now },
    nextExecutionTime: { type: Date, default: null, index: true },
    lastSentAt: { type: Date, default: null },
    repliedAt: { type: Date, default: null },
    replyMessage: { type: String, default: null },
    replyStepIndex: { type: Number, default: null }, // Step that prompted the reply
    replyLatencyMinutes: { type: Number, default: null }, // Mins from last send to reply
    customVariables: { type: Map, of: String, default: {} },
    logs: [dripRecipientLogSchema],
  },
  { timestamps: true }
);

dripRecipientSchema.index({ dripCampaignId: 1, status: 1 });
dripRecipientSchema.index({ status: 1, nextExecutionTime: 1 });
dripRecipientSchema.index({ userId: 1, chatJid: 1, status: 1 });

export default mongoose.model("DripRecipient", dripRecipientSchema);
