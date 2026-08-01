import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    metaAppId: { type: String, default: "" },
    metaAppSecret: { type: String, select: false, default: "" },
    webhookVerifyToken: { type: String, default: "whatsapp_saas_verify" },
    webhookUrl: { type: String, default: "" },
    apiVersion: { type: String, default: "v19.0" },
    embeddedSignupConfigId: { type: String, default: "" },
    allowNewRegistrations: { type: Boolean, default: true },
    maxWABAsPerUser: { type: Number, default: 5 },
    rateLimitPerMinute: { type: Number, default: 80 },
    maintenanceMode: { type: Boolean, default: false },
  },
  { timestamps: true }
);

settingsSchema.statics.getSingleton = async function () {
  let settings = await this.findOne();
  if (!settings) {
    settings = await this.create({});
  }
  return settings;
};

export default mongoose.model("MetaSystemSettings", settingsSchema);
