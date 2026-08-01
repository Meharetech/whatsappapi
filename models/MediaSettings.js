import mongoose from "mongoose";

const mediaSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    image:    { maxSizeMB: { type: Number, default: 10,  min: 1, max: 100 } },
    video:    { maxSizeMB: { type: Number, default: 50,  min: 1, max: 500 } },
    audio:    { maxSizeMB: { type: Number, default: 20,  min: 1, max: 100 } },
    document: { maxSizeMB: { type: Number, default: 25,  min: 1, max: 100 } },
  },
  { timestamps: true },
);

export default mongoose.model("MediaSettings", mediaSettingsSchema);
