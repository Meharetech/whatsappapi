import mongoose from "mongoose";

const aiReplyLogSchema = new mongoose.Schema(
  {
    agentId:      { type: mongoose.Schema.Types.ObjectId, ref: "AiAgent", required: true, index: true },
    userId:       { type: mongoose.Schema.Types.ObjectId, ref: "User",    required: true },
    sessionId:    { type: String, required: true },
    senderJid:    { type: String, required: true },
    inboundText:  { type: String, default: "" },
    replyText:    { type: String, default: "" },
  },
  { timestamps: true },
);

aiReplyLogSchema.index({ agentId: 1, createdAt: -1 });

export default mongoose.model("AiReplyLog", aiReplyLogSchema);
