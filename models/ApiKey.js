import mongoose from "mongoose";

const apiKeySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    // SHA-256 hash of the full key — never store the raw key
    keyHash: {
      type: String,
      required: true,
      unique: true,
    },
    // First 16 chars kept in plain text for display (e.g. "wac_live_a1b2c3d4")
    keyPrefix: {
      type: String,
      required: true,
    },
    environment: {
      type: String,
      enum: ["live", "test"],
      default: "live",
    },
    permissions: {
      type: [String],
      default: ["send_messages", "manage_sessions", "read_analytics"],
    },
    status: {
      type: String,
      enum: ["active", "revoked"],
      default: "active",
    },
    lastUsed: {
      type: Date,
      default: null,
    },
    callCount: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

apiKeySchema.index({ userId: 1, status: 1 });

export default mongoose.model("ApiKey", apiKeySchema);
