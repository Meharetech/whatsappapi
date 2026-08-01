import mongoose from "mongoose";

const metaCampaignSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    wabaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WABAccount",
      required: true,
    },
    phoneNumberId: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MessageTemplate",
      required: true,
    },
    templateName: { type: String, required: true },
    templateLanguage: { type: String, default: "en_US" },
    templateComponents: { type: Array, default: [] },
    recipients: [
      {
        phone: String,
        variables: Object,
      },
    ],
    status: {
      type: String,
      enum: ["draft", "running", "completed", "failed", "scheduled"],
      default: "draft",
    },
    scheduledFor: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    totalCount: { type: Number, default: 0 },
    sentCount: { type: Number, default: 0 },
    deliveredCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    delayMs: { type: Number, default: 1000 },
  },
  { timestamps: true }
);

export default mongoose.model("MetaCampaign", metaCampaignSchema);
