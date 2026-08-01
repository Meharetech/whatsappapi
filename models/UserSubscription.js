import mongoose from "mongoose";

const messageCounterSchema = new mongoose.Schema(
  {
    dayKey: { type: String, default: "" },
    dayCount: { type: Number, default: 0 },
    weekKey: { type: String, default: "" },
    weekCount: { type: Number, default: 0 },
    monthKey: { type: String, default: "" },
    monthCount: { type: Number, default: 0 },
  },
  { _id: false },
);

const usageSnapshotSchema = new mongoose.Schema(
  {
    sessions: { type: Number, default: 0 },
    campaigns: { type: Number, default: 0 },
    numberLists: { type: Number, default: 0 },
    storageBytes: { type: Number, default: 0 },
    messages: { type: messageCounterSchema, default: () => ({}) },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const userSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "trial", "expired", "cancelled"],
      default: "active",
    },
    startedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    location: { type: String, default: "" },
    usage: { type: usageSnapshotSchema, default: () => ({}) },
  },
  { timestamps: true },
);

export default mongoose.model("UserSubscription", userSubscriptionSchema);
