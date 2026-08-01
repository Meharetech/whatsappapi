import mongoose from "mongoose";

const phoneNumberSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    wabaId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WABAccount",
      required: true,
    },
    phoneNumberId: { type: String, required: true, unique: true },
    displayPhoneNumber: { type: String, default: "" },
    verifiedName: { type: String, default: "" },
    qualityRating: {
      type: String,
      enum: ["GREEN", "YELLOW", "RED", "UNKNOWN"],
      default: "UNKNOWN",
    },
    status: {
      type: String,
      enum: ["CONNECTED", "PENDING", "OFFLINE", "BANNED", "RESTRICTED", "FLAGGED"],
      default: "PENDING",
    },
    codeVerificationStatus: {
      type: String,
      enum: ["VERIFIED", "UNVERIFIED"],
      default: "UNVERIFIED",
    },
    messagingLimitTier: { type: String, default: "TIER_1K" },
    displayNameSubmitted: { type: String, default: "" },
    displayNameStatus: {
      type: String,
      enum: ["APPROVED", "PENDING", "REJECTED", null],
      default: null,
    },
    displayNameCategory: { type: String, default: "" },
  },
  { timestamps: true }
);

export default mongoose.model("PhoneNumber", phoneNumberSchema);
