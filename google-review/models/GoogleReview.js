import mongoose from "mongoose";

const GoogleReviewSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "GoogleReviewSession",
      required: true,
    },
    googleReviewId: String,
    authorName: String,
    authorPhoto: String,
    rating: { type: Number, enum: [1, 2, 3, 4, 5] },
    reviewText: String,
    reviewDate: Date,
    updateDate: Date,
    reviewUrl: String,
    isReplyNeeded: { type: Boolean, default: false },
    replyText: String,
    replyDate: Date,
    isReplied: { type: Boolean, default: false },
    sentiment: {
      type: String,
      enum: ["positive", "neutral", "negative"],
      default: "neutral",
    },
    tags: [String],
    status: {
      type: String,
      enum: ["new", "replied", "archived"],
      default: "new",
    },
  },
  { timestamps: true },
);

export default mongoose.model("GoogleReview", GoogleReviewSchema);
