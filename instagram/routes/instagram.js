import express from "express";
import instagramController from "../controllers/instagramController.js";
import instagramNotificationRoutes from "./instagram-notifications.js";
import authMiddleware from "../../middleware/auth.js";

const router = express.Router();

// Legacy endpoints (now disabled)
router.post("/connect", authMiddleware, instagramController.connect);
router.post("/challenge", authMiddleware, instagramController.submitChallenge);

// OAuth flow endpoints
router.get(
  "/oauth/initiate",
  authMiddleware,
  instagramController.initiateOAuth,
);
router.get("/oauth/callback", instagramController.oauthCallback);

// Media and comments endpoints
router.get("/media", authMiddleware, instagramController.fetchMedia);
router.get(
  "/media/counts",
  authMiddleware,
  instagramController.fetchMediaCounts,
);
router.get(
  "/media/:mediaId/comments",
  authMiddleware,
  instagramController.fetchComments,
);

// Direct messages (DMs)
router.get("/dms", authMiddleware, instagramController.fetchConversations);
router.get(
  "/dms/:conversationId/messages",
  authMiddleware,
  instagramController.fetchConversationMessages,
);
router.post("/dms/send", authMiddleware, instagramController.sendDirectMessage);
router.post(
  "/dms/:conversationId/approve",
  authMiddleware,
  instagramController.approveRequest,
);
router.post(
  "/dms/:conversationId/decline",
  authMiddleware,
  instagramController.declineRequest,
);
// Stored / fallback DM endpoints (no Graph required)
router.get(
  "/dms/stored",
  authMiddleware,
  instagramController.fetchStoredConversations,
);
router.get(
  "/dms/stored/:conversationId/messages",
  authMiddleware,
  instagramController.fetchStoredConversationMessages,
);

// Notifications - use database-backed notification system
router.use("/db-notifications", instagramNotificationRoutes);

// Legacy API notifications
router.get(
  "/notifications",
  authMiddleware,
  instagramController.fetchNotifications,
);

// Session management
router.get("/session", authMiddleware, instagramController.sessionStatus);
router.get(
  "/debug/token",
  authMiddleware,
  instagramController.debugTokenStatus,
);
router.delete("/", authMiddleware, instagramController.remove);

export default router;
