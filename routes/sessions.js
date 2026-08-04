import express from "express";
import sessionController from "../controllers/sessionController.js";
import messagingController from "../controllers/messagingController.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

router.post("/create", authMiddleware, sessionController.createSession);
router.get("/", authMiddleware, sessionController.listSessions);
router.get("/:id", authMiddleware, sessionController.getSession);
router.get("/:id/qr", authMiddleware, sessionController.getSessionQR);
router.delete("/:id", authMiddleware, sessionController.deleteSession);
router.post("/:id/logout", authMiddleware, sessionController.logoutSession);
router.post("/:id/pairing-code", authMiddleware, sessionController.getPairingCode);
router.post("/:id/reconnect", authMiddleware, sessionController.reconnectSession);
router.get("/:id/groups", authMiddleware, sessionController.getSessionGroups);
router.post("/:id/groups/create", authMiddleware, sessionController.createGroups);
router.get("/:id/groups/:groupId", authMiddleware, sessionController.getGroupMetadata);
router.get("/:id/groups/:groupId/invite-link", authMiddleware, sessionController.getGroupInviteLink);

router.get(
  "/:id/messages",
  authMiddleware,
  messagingController.getSessionMessages,
);

export default router;
