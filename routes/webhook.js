import express from "express";
import {
  verifyWebhook,
  receiveWebhook,
} from "../controllers/webhookController.js";

const router = express.Router();

// GET for verification
router.get("/", verifyWebhook);

// POST for incoming webhook events
router.post("/", receiveWebhook);

export default router;
