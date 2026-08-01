import mongoose from "mongoose";

const instagramAiAgentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      default: "Instagram AI Agent",
      trim: true,
      maxlength: 120,
    },
    account: {
      niche: { type: String, default: "", trim: true, maxlength: 140 },
      tone: { type: String, default: "", trim: true, maxlength: 140 },
      language: { type: String, default: "", trim: true, maxlength: 80 },
      about: { type: String, default: "", trim: true, maxlength: 2000 },
    },
    summary: {
      type: String,
      default: "",
      trim: true,
      maxlength: 4000,
    },
    model: {
      type: String,
      default: "openai/gpt-4o-mini",
      trim: true,
      maxlength: 120,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    replyCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    lastGeneratedAt: {
      type: Date,
      default: null,
    },
    sourceSessionId: {
      type: String,
      default: "",
      trim: true,
    },
    sourceAccount: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    autoReplyEnabled: {
      type: Boolean,
      default: false,
    },
    autoReplyStartedAt: {
      type: Date,
      default: null,
    },
    autoReplyLastRunAt: {
      type: Date,
      default: null,
    },
    commentSyncState: {
      type: mongoose.Schema.Types.Mixed,
      default: {
        mediaCursors: {},
        lastSyncAt: null,
      },
    },
  },
  { timestamps: true },
);

instagramAiAgentSchema.index({ userId: 1, isActive: 1 });
instagramAiAgentSchema.index({ autoReplyEnabled: 1 });

export default mongoose.model("InstagramAiAgent", instagramAiAgentSchema);
