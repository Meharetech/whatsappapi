import express from "express";
import authMiddleware from "../middleware/auth.js";
import groupMemberTaskController from "../controllers/groupMemberTaskController.js";

const router = express.Router();

router.use(authMiddleware);

router.post("/", groupMemberTaskController.createTask);
router.post("/resolve-invite", groupMemberTaskController.resolveInvite);
router.get("/", groupMemberTaskController.listTasks);
router.get("/:id", groupMemberTaskController.getTask);
router.post("/:id/start", groupMemberTaskController.startTask);
router.post("/:id/stop", groupMemberTaskController.stopTask);
router.post("/:id/retry-failed", groupMemberTaskController.resetFailedTask);
router.delete("/:id", groupMemberTaskController.deleteTask);

export default router;
