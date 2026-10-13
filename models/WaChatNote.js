import mongoose from "mongoose";

const waChatNoteSchema = new mongoose.Schema(
  {
    userId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    chatJid:   { type: String, required: true, index: true },
    note:      { type: String, required: true, trim: true },
  },
  { timestamps: true }
);

waChatNoteSchema.index({ userId: 1, sessionId: 1, chatJid: 1, createdAt: -1 });

export default mongoose.model("WaChatNote", waChatNoteSchema);
