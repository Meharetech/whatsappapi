import express from "express";
import authMiddleware from "../middleware/auth.js";
import upload from "../utils/fileUpload.js";
import mediaMessageController from "../controllers/mediaMessageController.js";

const router = express.Router();

router.post(
  "/send",
  authMiddleware,
  upload.single("file"),
  mediaMessageController.sendMediaMessage,
);

export default router;
