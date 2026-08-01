import express from "express";
import campaignController from "../controllers/campaignController.js";
import authMiddleware from "../middleware/auth.js";
import upload from "../utils/fileUpload.js";

const router = express.Router();

// Campaign CRUD
router.post(
  "/upload-media",
  authMiddleware,
  upload.single("file"),
  campaignController.uploadCampaignMedia,
);
router.post("/create", authMiddleware, campaignController.createCampaign);
router.get("/", authMiddleware, campaignController.getCampaigns);
router.get("/:id", authMiddleware, campaignController.getCampaignDetails);
router.delete("/:id", authMiddleware, campaignController.deleteCampaign);

// Campaign Actions
router.post("/:id/start", authMiddleware, campaignController.startCampaign);
router.post("/:id/pause", authMiddleware, campaignController.pauseCampaign);
router.post("/:id/resume", authMiddleware, campaignController.resumeCampaign);
router.post("/:id/retry", authMiddleware, campaignController.retryCampaign);
router.post("/:id/restart", authMiddleware, campaignController.restartCampaign);

// Campaign Report
router.get("/:id/report", authMiddleware, campaignController.getCampaignReport);

// Update campaign schedule / repeat / delay settings
router.patch(
  "/:id/schedule",
  authMiddleware,
  campaignController.updateCampaignSchedule,
);

// Update the primary session used by a campaign
router.patch(
  "/:id/session",
  authMiddleware,
  campaignController.updateCampaignSession,
);

export default router;
