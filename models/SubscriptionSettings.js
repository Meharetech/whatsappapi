import mongoose from "mongoose";

const subscriptionSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    demoEnabled: { type: Boolean, default: true },
    demoDurationDays: { type: Number, default: 3, min: 1 },
    defaultTrialDays: { type: Number, default: 3, min: 1 },
    demoPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },
    allowUserPlanSwitch: { type: Boolean, default: true },
    activeGateway: {
      type: String,
      enum: ["bharatsetu", "razorpay", "demo"],
      default: "bharatsetu",
    },
    bharatsetuUserToken: {
      type: String,
      default: "6072874f684ef0b45a57856b43b51229",
    },
    bharatsetuApiUrl: {
      type: String,
      default: "https://bharatsetu.xyz/api",
    },
    bharatsetuEnabled: { type: Boolean, default: true },
    razorpayKeyId: { type: String, default: "" },
    razorpayKeySecret: { type: String, default: "" },
    razorpayEnabled: { type: Boolean, default: false },
  },
  { timestamps: true },
);

export default mongoose.model(
  "SubscriptionSettings",
  subscriptionSettingsSchema,
);
