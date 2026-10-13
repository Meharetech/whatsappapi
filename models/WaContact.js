import mongoose from "mongoose";

const waContactSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    jid: { type: String, required: true },
    phoneNumber: { type: String, default: "" },
    name: { type: String, default: "" },
    pushName: { type: String, default: "" },
    verifiedName: { type: String, default: "" },
    profilePictureUrl: { type: String, default: null },
    lastSeen: { type: Date, default: null },
  },
  { timestamps: true }
);

waContactSchema.index({ userId: 1, sessionId: 1, jid: 1 }, { unique: true });
waContactSchema.index({ userId: 1, sessionId: 1, name: 1, phoneNumber: 1 });

export default mongoose.model("WaContact", waContactSchema);
