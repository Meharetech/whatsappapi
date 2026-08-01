import mongoose from "mongoose";

const aiKnowledgeSummarySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sourceType: {
      type: String,
      enum: ["text", "file"],
      required: true,
    },
    contextLineCount: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    contextPreview: {
      type: String,
      default: "",
      maxlength: 4000,
    },
    summary: {
      type: String,
      required: true,
      trim: true,
      maxlength: 4000,
    },
    model: {
      type: String,
      default: "openai/gpt-4o-mini",
      trim: true,
      maxlength: 120,
    },
    openRouterSettingsId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "OpenRouterSettings",
      required: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model("AiKnowledgeSummary", aiKnowledgeSummarySchema);
