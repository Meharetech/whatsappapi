import mongoose from "mongoose";

const InstagramSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    // Legacy fields for instagram-private-api (deprecated)
    instagram: {
      username: { type: String, trim: true },
      // encrypted serialized session blob
      session: { type: mongoose.Schema.Types.Mixed, default: null },
      lastLogin: { type: Date, default: null },
      proxyUrl: { type: String, default: null },
      device: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    // New Graph API fields
    graph: {
      facebookUserId: { type: String, trim: true },
      facebookUserAccessToken: { type: String, trim: true },
      facebookUserAccessTokenExpiresAt: { type: Date, default: null },
      facebookPageId: { type: String, trim: true },
      facebookPageAccessToken: { type: String, trim: true },
      instagramBusinessAccountId: { type: String, trim: true },
      manualInstagramBusinessAccountId: {
        type: String,
        trim: true,
        default: null,
      },
      discoveryMode: { type: String, trim: true, default: null },
      instagramUsername: { type: String, trim: true },
      instagramProfilePictureUrl: { type: String, trim: true },
      instagramFollowersCount: { type: Number, default: 0 },
      instagramMediaCount: { type: Number, default: 0 },
      scopes: [{ type: String }],
      lastRefreshed: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: [
        "connected",
        "challenge_required",
        "disconnected",
        "oauth_connected",
      ],
      default: "disconnected",
    },
  },
  { timestamps: true },
);

export default mongoose.model("InstagramSession", InstagramSessionSchema);
