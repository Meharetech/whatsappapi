import mongoose from "mongoose";

const participantSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    admin: { type: String, default: null }, // "admin" | "superadmin" | null
    phoneNumber: { type: String, default: "" },
    lid: { type: String, default: null },
  },
  { _id: false }
);

const whatsAppGroupSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    jid: {
      type: String,
      required: true,
      trim: true,
    },
    subject: {
      type: String,
      default: "WhatsApp Group",
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    owner: {
      type: String,
      default: null,
    },
    creation: {
      type: Number,
      default: null,
    },
    participants: {
      type: [participantSchema],
      default: [],
    },
    participantCount: {
      type: Number,
      default: 0,
    },
    announce: {
      type: Boolean,
      default: false, // true = only admins can send messages
    },
    restrict: {
      type: Boolean,
      default: false, // true = only admins can edit info
    },
    size: {
      type: Number,
      default: 0,
    },
    profilePic: {
      type: String,
      default: null,
    },
    canSend: {
      type: Boolean,
      default: true, // whether the connected bot account has permission to post
    },
    isMeAdmin: {
      type: Boolean,
      default: false, // whether the connected bot account is an admin
    },
    inviteCode: {
      type: String,
      default: null,
    },
    lastSyncedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: one record per group per session
whatsAppGroupSchema.index({ sessionId: 1, jid: 1 }, { unique: true });
whatsAppGroupSchema.index({ userId: 1, sessionId: 1 });
whatsAppGroupSchema.index({ sessionId: 1, subject: 1 });
whatsAppGroupSchema.index({ sessionId: 1, participantCount: -1 });
whatsAppGroupSchema.index({ sessionId: 1, updatedAt: -1 });

export default mongoose.model("WhatsAppGroup", whatsAppGroupSchema);
