import express from "express";
import {
  createCampaign,
  deleteCampaign,
  listCampaigns,
  getCampaign,
  proxyPreviewVideo,
  retryReel,
  deleteReel,
  pauseCampaign,
  resumeCampaign,
  triggerUploadCheck,
  debugTokenStatus,
} from "../controllers/reelCampaignController.js";
import auth from "../middleware/auth.js";

const router = express.Router();

router.post("/", auth, createCampaign);
router.get("/", auth, listCampaigns);
router.get("/preview-video", proxyPreviewVideo);
router.get("/:id", auth, getCampaign);
router.delete("/:id", auth, deleteCampaign);
router.post("/:id/pause", auth, pauseCampaign);
router.post("/:id/resume", auth, resumeCampaign);
router.post("/reel/:id/retry", auth, retryReel);
router.delete("/reel/:id", auth, deleteReel);
router.get("/debug/trigger-upload-check", triggerUploadCheck);
router.get("/debug/token-status", auth, debugTokenStatus);

export default router;
