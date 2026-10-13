import mongoose from "mongoose";

const groupBroadcastSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  sessionId: {
    type: String,
    required: true,
  },
  groupJids: [{
    type: String,
  }],
  targetGroups: [
    {
      jid: String,
      groupName: String,
      memberCount: { type: Number, default: 0 }
    }
  ],
  message: {
    type: String,
  },
  mediaUrl: {
    type: String,
  },
  mediaName: {
    type: String,
  },
  mode: {
    type: String,
    enum: ["instant", "repeat"],
    required: true,
  },
  intervalMs: {
    type: Number,
  },
  replyToLast: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: ["draft", "running", "paused", "completed", "failed"],
    default: "draft",
  },
  minDelayMs: {
    type: Number,
    default: 3000,
  },
  maxDelayMs: {
    type: Number,
    default: 8000,
  },
  stats: {
    total: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    totalMembers: { type: Number, default: 0 },
    sentMembers: { type: Number, default: 0 },
    failedMembers: { type: Number, default: 0 }
  },
  results: [
    {
      jid: String,
      groupName: String,
      memberCount: { type: Number, default: 0 },
      status: String,
      error: String
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  }
});

export default mongoose.model("GroupBroadcast", groupBroadcastSchema);
