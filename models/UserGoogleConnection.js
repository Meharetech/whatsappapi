import mongoose from "mongoose";

const userGoogleConnectionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true, index: true },
    accessToken: { type: String, default: "", select: false },
    expiresAt: { type: Date, default: null },
    email: { type: String, default: "" },
    name: { type: String, default: "" },
    picture: { type: String, default: "" },
  },
  { timestamps: true },
);

export default mongoose.model("UserGoogleConnection", userGoogleConnectionSchema);
