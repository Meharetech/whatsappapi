import mongoose from "mongoose";

const metaMessageSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    wabaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WABAccount",
    },
    phoneNumberId: { type: String, default: "" },
    to: { type: String, required: true },
    from: { type: String, default: "" },
    messageId: { type: String, default: "", index: true },
    type: {
      type: String,
      enum: ["text", "template", "incoming"],
      default: "text",
    },
    body: { type: String, default: "" },
    templateName: { type: String, default: "" },
    templateLanguage: { type: String, default: "" },
    templateComponents: { type: Array, default: [] },
    status: {
      type: String,
      enum: ["sending", "sent", "delivered", "read", "failed"],
      default: "sending",
    },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    deliveredAt: { type: Date, default: null },
    readAt: { type: Date, default: null },
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MetaCampaign",
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("MetaMessage", metaMessageSchema);
