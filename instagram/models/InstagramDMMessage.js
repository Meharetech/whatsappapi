import mongoose from "mongoose";

const instagramDmSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    conversationId: { type: String, index: true },
    fromId: { type: String, default: "" },
    toId: { type: String, default: "" },
    messageId: { type: String, index: true },
    text: { type: String, default: "" },
    isRequest: { type: Boolean, default: false },
    raw: { type: Object, default: {} },
    receivedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

instagramDmSchema.index({ userId: 1, conversationId: 1, receivedAt: -1 });

export default mongoose.model("InstagramDMMessage", instagramDmSchema);
