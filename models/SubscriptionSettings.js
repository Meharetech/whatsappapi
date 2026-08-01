import mongoose from "mongoose";

const subscriptionSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    demoEnabled: { type: Boolean, default: true },
    demoDurationDays: { type: Number, default: 7, min: 1 },
    demoPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },
    allowUserPlanSwitch: { type: Boolean, default: true },
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
