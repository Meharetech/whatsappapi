import mongoose from "mongoose";

const whatsAppAuthStateSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
    },
    dataType: {
      type: String,
      required: true,
    },
    dataId: {
      type: String,
      required: true,
    },
    dataJson: {
      type: String,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index to ensure uniqueness per session + data type + key/creds identifier
whatsAppAuthStateSchema.index({ sessionId: 1, dataType: 1, dataId: 1 }, { unique: true });

export default mongoose.model("WhatsAppAuthState", whatsAppAuthStateSchema);
