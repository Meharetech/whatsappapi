import mongoose from "mongoose";

const componentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["HEADER", "BODY", "FOOTER", "BUTTONS"],
      required: true,
    },
    format: { type: String, default: null },
    text: { type: String, default: "" },
    buttons: { type: Array, default: [] },
    example: { type: Object, default: null },
  },
  { _id: false },
);

const templateSchema = new mongoose.Schema(
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
    metaTemplateId: { type: String, default: "" },
    name: { type: String, required: true, lowercase: true, trim: true },
    language: { type: String, required: true, default: "en_US" },
    category: {
      type: String,
      enum: ["MARKETING", "UTILITY", "AUTHENTICATION"],
      required: true,
    },
    status: {
      type: String,
      enum: ["APPROVED", "PENDING", "REJECTED", "PAUSED", "DRAFT"],
      default: "DRAFT",
    },
    components: [componentSchema],
    rejectionReason: { type: String, default: "" },
    lastSyncedAt: { type: Date, default: null },
    isFlagged: { type: Boolean, default: false },
    adminNote: { type: String, default: "" },
  },
  { timestamps: true },
);

export default mongoose.model("MessageTemplate", templateSchema);
