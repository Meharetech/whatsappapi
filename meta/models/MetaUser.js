import mongoose from "mongoose";

const metaUserSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    facebookId: { type: String, unique: true, sparse: true },
    facebookName: { type: String, default: "" },
    facebookEmail: { type: String, default: "" },
    facebookPicture: { type: String, default: "" },
    longLivedToken: { type: String, select: false, default: "" },
    tokenExpiresAt: { type: Date, default: null },
    isConnected: { type: Boolean, default: false },
    scopes: { type: [String], default: [] },
  },
  { timestamps: true }
);

metaUserSchema.methods.isTokenValid = function () {
  if (!this.longLivedToken) return false;
  if (!this.tokenExpiresAt) return true;
  return new Date() < this.tokenExpiresAt;
};

export default mongoose.model("MetaUser", metaUserSchema);
