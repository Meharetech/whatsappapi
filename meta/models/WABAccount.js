import mongoose from "mongoose";

const wabAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    wabaId: { type: String, required: true, unique: true },
    businessAccountId: { type: String, default: "" },
    businessName: { type: String, default: "" },
    accessToken: { type: String, select: false, default: "" },
    currency: { type: String, default: "USD" },
    timezoneId: { type: String, default: "1" },
    status: {
      type: String,
      enum: ["active", "suspended", "disconnected"],
      default: "active",
    },
    messageTemplateNamespace: { type: String, default: "" },
    onBehalfOfBusinessInfo: { type: Object, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("WABAccount", wabAccountSchema);
