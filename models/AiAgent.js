import mongoose from "mongoose";

const aiAgentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    sessionId: { type: String, required: true, index: true },
    agentName: { type: String, default: "AI Auto-Reply Agent", trim: true },
    isActive: { type: Boolean, default: true },

    knowledgeSummaryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AiKnowledgeSummary",
      default: null,
    },
    replyCount: { type: Number, default: 0 },
    lastRepliedAt: { type: Date, default: null },

    // Add auto-reply state
    autoReplyEnabled: { type: Boolean, default: false },
    autoReplyStartedAt: { type: Date, default: null },

    config: {
      trigger: {
        condition: {
          type: String,
          enum: ["all", "new", "keywords"],
          default: "all",
        },
        keywords: { type: String, default: "" },
      },
      reply: {
        delay: {
          type: String,
          enum: ["instant", "natural", "slow"],
          default: "natural",
        },
        escalate: { type: String, default: "" },
        afterHours: { type: String, default: "" },
      },
    },
  },
  { timestamps: true },
);

// One agent per session per user
aiAgentSchema.index({ userId: 1, sessionId: 1 }, { unique: true });

export default mongoose.model("AiAgent", aiAgentSchema);
