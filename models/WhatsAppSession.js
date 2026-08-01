import mongoose from "mongoose";

const whatsAppSessionSchema = new mongoose.Schema(
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
    sessionId: {
      type: String,
      required: true,
      unique: true,
    },
    phoneNumber: {
      type: String,
      default: "",
    },
    status: {
      type: String,
      enum: ["pending", "connecting", "connected", "disconnected", "failed"],
      default: "pending",
    },
    credentials: {
      type: mongoose.Schema.Types.Mixed,
      select: false,
    },
    lastConnected: {
      type: Date,
      default: null,
    },
    chatViewEnabled: {
      type: Boolean,
      default: false,
    },
    chatPasscodeHash: {
      type: String,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
  },
);

whatsAppSessionSchema.index({ userId: 1, sessionId: 1 });

export default mongoose.model("WhatsAppSession", whatsAppSessionSchema);
