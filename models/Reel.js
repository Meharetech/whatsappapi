import mongoose from "mongoose";

const ReelSchema = new mongoose.Schema(
  {
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: "ReelCampaign" },
    index: { type: Number, required: true },
    // Local file path (if downloaded) — optional when using `videoUrl`
    path: { type: String },
    // Public cloud URL for video (preferred for Pinterest posts)
    videoUrl: { type: String },
    thumbnail: { type: String },

    // AI-generated caption data (full JSON with title, hook, cta, etc)
    captionData: {
      title: { type: String },
      hook: { type: String },
      cta: { type: String },
      caption: { type: String },
      hashtags: { type: [String], default: [] },
    },

    // Legacy: string version of caption (for backward compatibility)
    caption: { type: String },
    hashtags: { type: [String], default: [] },

    scheduledFor: { type: Date },
    status: {
      type: String,
      enum: ["pending", "processing", "uploading", "uploaded", "failed"],
      default: "pending",
    },

    // Instagram upload result
    instagramMediaId: { type: String },
    instagramPermalink: { type: String },

    error: { type: String },
  },
  { timestamps: true },
);

export default mongoose.model("Reel", ReelSchema);
