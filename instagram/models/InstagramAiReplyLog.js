import mongoose from "mongoose";

const instagramAiReplyLogSchema = new mongoose.Schema(
  {
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstagramAiAgent",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    post: {
      caption: { type: String, default: "" },
      type: { type: String, default: "" },
      mediaType: { type: String, default: "" },
      permalink: { type: String, default: "" },
      mediaUrl: { type: String, default: "" },
      likeCount: { type: Number, default: 0 },
      commentsCount: { type: Number, default: 0 },
      keywords: [{ type: String }],
      id: { type: String, default: "" },
    },
    comment: {
      text: { type: String, default: "" },
      username: { type: String, default: "" },
    },
    category: { type: String, default: "GENERAL", index: true },
    sentiment: { type: String, default: "NEUTRAL", index: true },
    action: { type: String, default: "" },
    reply: { type: String, default: "" },
    rawResponse: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

instagramAiReplyLogSchema.index({ agentId: 1, createdAt: -1 });

export default mongoose.model("InstagramAiReplyLog", instagramAiReplyLogSchema);
