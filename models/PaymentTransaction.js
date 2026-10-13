import mongoose from "mongoose";

const paymentTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    gateway: {
      type: String,
      enum: ["bharatsetu", "razorpay", "demo", "free"],
      default: "bharatsetu",
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "INR",
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly"],
      default: "monthly",
    },
    customerMobile: {
      type: String,
      default: "9999999999",
    },
    paymentUrl: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["created", "pending", "success", "failed", "cancelled"],
      default: "pending",
      index: true,
    },
    gatewayResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

export default mongoose.model("PaymentTransaction", paymentTransactionSchema);
