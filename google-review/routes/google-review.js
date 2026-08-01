import express from "express";
import googleReviewController from "../controllers/googleReviewController.js";
import auth from "../../middleware/auth.js";

const router = express.Router();

// OAuth flow
router.get("/oauth/callback", googleReviewController.oauthCallback);
router.post("/oauth/start", auth, googleReviewController.oauthStart);
router.get("/oauth/status", auth, googleReviewController.oauthStatus);
router.post("/oauth/disconnect", auth, googleReviewController.oauthDisconnect);
router.post(
  "/oauth/accept-unverified",
  auth,
  googleReviewController.oauthAcceptUnverified,
);

// Connection management
router.post("/connect", auth, googleReviewController.connect);
router.get("/sessions", auth, googleReviewController.getSession);

// Review management
router.get("/:sessionId/reviews", auth, googleReviewController.getReviews);
router.post("/:reviewId/reply", auth, googleReviewController.replyToReview);
router.post("/:sessionId/sync", auth, googleReviewController.syncReviews);

// Analytics
router.get("/:sessionId/analytics", auth, googleReviewController.getAnalytics);

export default router;
