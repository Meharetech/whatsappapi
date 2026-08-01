import mongoose from "mongoose";

const featureSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
  },
  { _id: false },
);

const subscriptionPlanSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: { type: String, default: "", trim: true },
    currency: { type: String, default: "INR", trim: true },
    priceMonthly: { type: Number, default: 0, min: 0 },
    priceYearly: { type: Number, default: 0, min: 0 },
    durationDays: { type: Number, default: 30, min: 1 },
    isActive: { type: Boolean, default: true },
    isDemo: { type: Boolean, default: false },
    isCustom: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 100 },
    assignToRoles: [{ type: String, trim: true }],
    assignToLocations: [{ type: String, trim: true }],
    limits: {
      sessions: { type: Number, default: -1 },
      campaigns: { type: Number, default: -1 },
      numberLists: { type: Number, default: -1 },
      storageMb: { type: Number, default: -1 },
      messagesDaily: { type: Number, default: -1 },
      messagesWeekly: { type: Number, default: -1 },
      messagesMonthly: { type: Number, default: -1 },
    },
    features: [featureSchema],
  },
  { timestamps: true },
);

subscriptionPlanSchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
