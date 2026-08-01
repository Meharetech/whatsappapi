import mongoose from "mongoose";

const GoogleReviewSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    businessName: String,
    businessId: String,
    googlePlacesId: String,
    googleAccountName: String,
    googleLocationName: String,
    googleLocationTitle: String,
    googleLocationStoreCode: String,
    locationState: { type: mongoose.Schema.Types.Mixed, default: {} },
    isLocationVerified: { type: Boolean, default: false },
    businessProfileStatus: {
      type: String,
      enum: ["verified", "unverified", "none", "error"],
      default: "none",
    },
    businessProfileMessage: String,
    businessProfileCheckedAt: Date,
    accessToken: String,
    refreshToken: String,
    tokenExpiresAt: Date,
    businessAddress: String,
    businessPhone: String,
    businessWebsite: String,
    businessPhoto: String,
    averageRating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    lastSyncedAt: Date,
    connectionStatus: {
      type: String,
      enum: ["connected", "disconnected", "error"],
      default: "connected",
    },
    connectionError: String,
  },
  { timestamps: true },
);

export default mongoose.model("GoogleReviewSession", GoogleReviewSessionSchema);
