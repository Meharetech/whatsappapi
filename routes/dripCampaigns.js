import express from "express";
import authMiddleware from "../middleware/auth.js";
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  duplicateCampaign,
  toggleStatus,
  enrollContacts,
  listRecipients,
  listAllLeads,
  getFunnel,
  triggerRecipientNow,
  skipRecipientStep,
  resumeRecipient,
  cancelRecipient,
  markRecipientReplied,
  exportLeads,
} from "../controllers/dripController.js";

const router = express.Router();

// Apply authentication middleware to all drip campaign routes
router.use(authMiddleware);

// Global Leads & Replied Leads endpoint (Must be before /:id)
router.get("/leads/all", listAllLeads);

// Campaign CRUD & Duplication
router.get("/", listCampaigns);
router.post("/", createCampaign);
router.get("/:id", getCampaign);
router.put("/:id", updateCampaign);
router.delete("/:id", deleteCampaign);
router.post("/:id/duplicate", duplicateCampaign);

// Actions & Funnel
router.post("/:id/status", toggleStatus);
router.post("/:id/enroll", enrollContacts);
router.get("/:id/funnel", getFunnel);
router.get("/:id/export", exportLeads);

// Recipients / Leads tracking & Overrides
router.get("/:id/recipients", listRecipients);
router.post("/:id/recipients/:recipientId/trigger-now", triggerRecipientNow);
router.post("/:id/recipients/:recipientId/skip-step", skipRecipientStep);
router.post("/:id/recipients/:recipientId/resume", resumeRecipient);
router.post("/:id/recipients/:recipientId/cancel", cancelRecipient);
router.post("/:id/recipients/:recipientId/mark-replied", markRecipientReplied);

export default router;
