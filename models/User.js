import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: function () {
        return this.authProvider === "local";
      },
      minlength: 6,
    },
    authProvider: {
      type: String,
      enum: ["local", "google"],
      default: "local",
    },
    firebaseUid: {
      type: String,
      default: "",
      index: true,
    },
    googleEmailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerified: {
      type: Boolean,
      default: true,
    },
    avatarUrl: {
      type: String,
      default: "",
    },
    name: {
      type: String,
      default: "",
    },
    location: {
      type: String,
      default: "",
      trim: true,
    },
    role: {
      type: String,
      enum: ["user", "admin", "superadmin"],
      default: "user",
    },
    phone: { type: String, default: "" },
    company: { type: String, default: "" },
    bio: { type: String, default: "" },
    timezone: { type: String, default: "Asia/Kolkata" },
    language: { type: String, default: "en" },
    notificationPrefs: {
      sessionDisconnect: { type: Boolean, default: true },
      deliveryFailures: { type: Boolean, default: true },
      usageWarnings: { type: Boolean, default: true },
      weeklySummary: { type: Boolean, default: false },
      marketing: { type: Boolean, default: false },
    },
    chatPasscodeHash: { type: String, default: null, select: false },
  },
  {
    timestamps: true,
  },
);

userSchema.pre("save", async function (next) {
  if (!this.password || !this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

export default mongoose.model("User", userSchema);
