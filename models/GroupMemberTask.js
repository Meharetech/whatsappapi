import mongoose from "mongoose";

const groupMemberTaskSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      default: "Group Member Addition Task",
    },
    targetGroup: {
      jid: { type: String, default: "" },
      subject: { type: String, default: "" },
      inviteCode: { type: String, default: "" },
      inviteUrl: { type: String, default: "" },
    },
    addingSessions: [
      {
        sessionId: { type: String, required: true },
        name: { type: String, default: "" },
        phoneNumber: { type: String, default: "" },
        quota: { type: Number, default: 0 },
      },
    ],
    members: [
      {
        phone: { type: String, required: true },
        jid: { type: String },
        assignedSessionId: { type: String, required: true },
        processedBySessionId: { type: String, default: "" },
        processedByPhoneNumber: { type: String, default: "" },
        processedByName: { type: String, default: "" },
        status: {
          type: String,
          enum: ["pending", "added", "invited", "failed"],
          default: "pending",
        },
        error: { type: String, default: "" },
        addedAt: { type: Date, default: null },
      },
    ],
    delaySeconds: {
      type: Number,
      default: 8,
    },
    delayMaxSeconds: {
      type: Number,
      default: 14,
    },
    membersPerBatch: {
      type: Number,
      default: 2,
    },
    batchSize: {
      type: Number,
      default: 10,
    },
    batchCooldownSeconds: {
      type: Number,
      default: 25,
    },
    rotationMode: {
      type: String,
      default: "round-robin",
    },
    autoSendInviteLink: {
      type: Boolean,
      default: false,
    },
    skipExistingMembers: {
      type: Boolean,
      default: true,
    },
    countryCode: {
      type: String,
      default: "91",
    },
    autoAddCountryCode: {
      type: Boolean,
      default: true,
    },
    joinBeforeAdding: {
      type: Boolean,
      default: true,
    },
    joinWaitSeconds: {
      type: Number,
      default: 30,
    },
    hasJoinedViaInvite: {
      type: Boolean,
      default: false,
    },
    status: {
      type: String,
      enum: ["draft", "running", "paused", "completed", "failed"],
      default: "draft",
      index: true,
    },
    stats: {
      total: { type: Number, default: 0 },
      added: { type: Number, default: 0 },
      invited: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
    },
    lastError: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

export default mongoose.model("GroupMemberTask", groupMemberTaskSchema);
