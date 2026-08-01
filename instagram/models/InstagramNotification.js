import mongoose from "mongoose";

const instagramNotificationSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "like",
        "comment",
        "share",
        "follow",
        "mention",
        "story_view",
        "direct_message",
      ],
      default: "follow",
    },
    message: {
      type: String,
      required: true,
    },
    userName: {
      type: String,
      default: null,
    },
    userUsername: {
      type: String,
      default: null,
    },
    userProfilePic: {
      type: String,
      default: null,
    },
    relatedContent: {
      type: String,
      default: null,
    },
    thumbnail: {
      type: String,
      default: null,
    },
    instagramNotificationId: {
      type: String,
      unique: true,
      sparse: true,
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    isArchived: {
      type: Boolean,
      default: false,
      index: true,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
  },
);

// Compound indexes for common queries
instagramNotificationSchema.index({ userId: 1, isRead: 1 });
instagramNotificationSchema.index({ userId: 1, isArchived: 1 });
instagramNotificationSchema.index({ userId: 1, createdAt: -1 });

export default mongoose.model(
  "InstagramNotification",
  instagramNotificationSchema,
);
