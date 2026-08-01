import mongoose from "mongoose";

const ReelCampaignSchema = new mongoose.Schema(
  {
    sourceType: { type: String, default: "youtube" },
    sourceUrl: { type: String },
    sourceTitle: { type: String },
    youtubeUrl: { type: String },
    youtubeTitle: { type: String },
    campaignTitle: { type: String, required: true },
    reelLengthSec: { type: Number, default: 60 },
    uploadGapMinutes: { type: Number, default: 60 },
    captionTone: { type: String },
    hashtagCount: { type: Number, default: 5 },
    autoDelete: { type: Boolean, default: true },
    autoStart: { type: Boolean, default: false },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "running",
        "paused",
        "completed",
        "failed",
      ],
      default: "pending",
    },
    previousStatus: { type: String }, // Store previous status for resume
    totalReels: { type: Number, default: 0 },
    uploadedReels: { type: Number, default: 0 },
    failedReels: { type: Number, default: 0 },
    thumbnail: { type: String },
    tempDownloadPath: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

export default mongoose.model("ReelCampaign", ReelCampaignSchema);
