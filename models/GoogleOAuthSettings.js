import mongoose from "mongoose";

const googleOAuthSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    clientId: { type: String, default: "", trim: true },
    clientSecret: { type: String, default: "", trim: true, select: false },
    enabled: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export default mongoose.model("GoogleOAuthSettings", googleOAuthSettingsSchema);
