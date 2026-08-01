import mongoose from "mongoose";

const instagramProcessedCommentSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "InstagramAiAgent",
      required: true,
      index: true,
    },
    commentId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    mediaId: {
      type: String,
      default: "",
      trim: true,
      index: true,
    },
    parentId: {
      type: String,
      default: "",
      trim: true,
    },
    username: {
      type: String,
      default: "",
      trim: true,
      lowercase: true,
    },
    commentText: {
      type: String,
      default: "",
      trim: true,
      maxlength: 5000,
    },
    status: {
      type: String,
      enum: ["processing", "replied", "skipped", "failed"],
      default: "processing",
      index: true,
    },
    aiReply: {
      type: String,
      default: "",
      trim: true,
      maxlength: 5000,
    },
    error: {
      type: String,
      default: "",
      trim: true,
      maxlength: 1000,
    },
    processedAt: {
      type: Date,
      default: null,
    },
    repliedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

instagramProcessedCommentSchema.index(
  { userId: 1, agentId: 1, commentId: 1 },
  { unique: true },
);
instagramProcessedCommentSchema.index({ agentId: 1, status: 1, createdAt: -1 });

export default mongoose.model(
  "InstagramProcessedComment",
  instagramProcessedCommentSchema,
);
