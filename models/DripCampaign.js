import mongoose from "mongoose";

const dripStepSchema = new mongoose.Schema(
  {
    stepIndex: { type: Number, required: true }, // 1, 2, 3...
    delayValue: { type: Number, default: 1 },    // e.g. 1, 2, 24
    delayUnit: {
      type: String,
      enum: ["minutes", "hours", "days"],
      default: "days",
    },
    message: { type: String, default: "" },      // Supports {{name}}, {{phone}}, {Spintax|Variants}
    mediaUrl: { type: String, default: null },
    mediaType: {
      type: String,
      enum: ["image", "video", "document", "audio", null],
      default: null,
    },
    mediaName: { type: String, default: null },
  },
  { _id: true }
);

const dripCampaignSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    sessionId: { type: String, required: true, index: true }, // WhatsApp Session Ref
    status: {
      type: String,
      enum: ["draft", "active", "paused", "completed"],
      default: "active",
      index: true,
    },
    steps: [dripStepSchema],
    settings: {
      stopOnReply: { type: Boolean, default: true },
      notifyOnReply: { type: Boolean, default: true },
      sendWindow: {
        enabled: { type: Boolean, default: false },
        startHour: { type: Number, default: 9 },  // 9 AM
        endHour: { type: Number, default: 20 },   // 8 PM
      },
    },
    stats: {
      totalEnrolled: { type: Number, default: 0 },
      activeCount: { type: Number, default: 0 },
      repliedCount: { type: Number, default: 0 },
      completedCount: { type: Number, default: 0 },
      failedCount: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

dripCampaignSchema.index({ userId: 1, status: 1 });

export default mongoose.model("DripCampaign", dripCampaignSchema);
