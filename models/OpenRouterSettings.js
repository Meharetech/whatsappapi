import mongoose from "mongoose";

const openRouterSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    provider: { type: String, default: "openrouter" },
    apiKey: { type: String, default: "" },
    model: {
      type: String,
      default: "openai/gpt-4o-mini",
      trim: true,
      maxlength: 120,
    },
  },
  { timestamps: true },
);

export default mongoose.model("OpenRouterSettings", openRouterSettingsSchema);
