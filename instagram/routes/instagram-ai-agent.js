import express from "express";
import authMiddleware from "../../middleware/auth.js";
import {
  getAgentStatus,
  setupAgent,
  generateReply,
  getLogs,
  fetchPendingComments,
  generateAndPostReply,
  testReply,
  toggleAgentStatus,
  updateAgentSettings,
  getAnalytics,
  startAutoReply,
  stopAutoReply,
} from "../controllers/instagramAiAgentController.js";

const router = express.Router();

router.use(authMiddleware);

router.get("/status", getAgentStatus);
router.post("/setup", setupAgent);
router.post("/reply", generateReply);
router.post("/test-reply", testReply);
router.get("/logs", getLogs);
router.get("/pending-comments", fetchPendingComments);
router.post("/post-reply", generateAndPostReply);
router.post("/toggle-status", toggleAgentStatus);
router.post("/update-settings", updateAgentSettings);
router.get("/analytics", getAnalytics);
router.post("/start-auto-reply", startAutoReply);
router.post("/stop-auto-reply", stopAutoReply);

export default router;
