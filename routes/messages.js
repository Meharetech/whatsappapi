import express from "express";
import messagingController from "../controllers/messagingController.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

router.post("/send", authMiddleware, messagingController.sendMessage);
router.get("/session/:id", authMiddleware, messagingController.getSessionMessages);
router.put(
  "/status/:messageId",
  authMiddleware,
  messagingController.updateMessageStatus,
);

export default router;
