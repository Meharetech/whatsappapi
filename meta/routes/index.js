import express from "express";
import authMiddleware from "../../middleware/auth.js";

import * as authCtrl from "../controllers/authController.js";
import * as businessCtrl from "../controllers/businessController.js";
import * as numberCtrl from "../controllers/numberController.js";
import * as templateCtrl from "../controllers/templateController.js";
import * as messagingCtrl from "../controllers/messagingController.js";
import * as webhookCtrl from "../controllers/webhookController.js";
import * as adminCtrl from "../controllers/adminController.js";

const router = express.Router();

// ─── Webhook (no auth) ────────────────────────────────────────────────────
router.get("/webhook", webhookCtrl.verifyWebhook);
router.post("/webhook", webhookCtrl.receiveWebhook);

// ─── All routes below require JWT auth ────────────────────────────────────
router.use(authMiddleware);

// Auth / Facebook Connection
router.post("/auth/exchange-code", authCtrl.exchangeFacebookCode);
router.post("/auth/facebook", authCtrl.saveFacebookToken);
router.get("/auth/config", authCtrl.getMetaOAuthConfig);
router.get("/auth/status", authCtrl.getMetaStatus);
router.delete("/auth/disconnect", authCtrl.disconnectFacebook);

// Businesses / WABA
router.get("/business", businessCtrl.getBusinesses);
router.post("/business", businessCtrl.connectBusiness);
router.post("/business/sync", businessCtrl.syncBusinesses);
router.get("/business/:wabaId", businessCtrl.getBusinessById);
router.delete("/business/:wabaId", businessCtrl.disconnectBusiness);

// Phone Numbers
router.get("/numbers", numberCtrl.getNumbers);
router.post("/numbers/sync/:wabaDbId", numberCtrl.syncNumbers);
router.get("/numbers/:id", numberCtrl.getNumberById);
router.post("/numbers/:id/display-name", numberCtrl.submitDisplayName);

// Templates
router.get("/templates", templateCtrl.getTemplates);
router.post("/templates", templateCtrl.createTemplate);
router.post("/templates/sync-all", templateCtrl.syncAllTemplates);
router.get("/templates/:id", templateCtrl.getTemplateById);
router.delete("/templates/:id", templateCtrl.deleteTemplate);
router.post("/templates/:id/sync", templateCtrl.syncTemplate);

// Messaging
router.post("/messages/send", messagingCtrl.sendMessage);
router.get("/messages", messagingCtrl.getMessages);

// Campaigns
router.get("/campaigns", messagingCtrl.getCampaigns);
router.post("/campaigns", messagingCtrl.createCampaign);
router.get("/campaigns/:id", messagingCtrl.getCampaignById);
router.post("/campaigns/:id/start", messagingCtrl.startCampaign);

// ─── Admin Routes ─────────────────────────────────────────────────────────
router.get("/admin/users", adminCtrl.getUsers);
router.get("/admin/businesses", adminCtrl.getBusinesses);
router.put("/admin/businesses/:wabaId/status", adminCtrl.setBusinessStatus);
router.get("/admin/messages", adminCtrl.getMessages);
router.get("/admin/templates", adminCtrl.getTemplates);
router.put("/admin/templates/:id/moderate", adminCtrl.moderateTemplate);
router.get("/admin/analytics", adminCtrl.getAnalytics);
router.get("/admin/settings", adminCtrl.getSettings);
router.put("/admin/settings", adminCtrl.updateSettings);

export default router;
