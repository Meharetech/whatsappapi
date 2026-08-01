import express from "express";
import crypto from "crypto";
import authMiddleware from "../middleware/auth.js";
import { createApiKey, listApiKeys, revokeApiKey, deleteApiKey } from "../controllers/apiKeyController.js";
import ApiKey from "../models/ApiKey.js";

const router = express.Router();

// ── PUBLIC: debug/check endpoint (no auth needed) ──────────────────────────────
// POST /api/api-keys/check  body: { key: "wac_live_…" }
router.post("/check", async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: "key is required" });

    const total   = await ApiKey.countDocuments();
    const active  = await ApiKey.countDocuments({ status: "active" });
    const keyHash = crypto.createHash("sha256").update(key).digest("hex");
    const found   = await ApiKey.findOne({ keyHash }).select("keyPrefix environment status createdAt");

    console.log("🔍 [CHECK] key prefix:", key.slice(0, 20), "| hash:", keyHash.slice(0, 20), "| found:", !!found);

    res.json({
      totalKeysInDB: total,
      activeKeysInDB: active,
      keyStartsCorrectly: key.startsWith("wac_live_") || key.startsWith("wac_test_"),
      keyLength: key.length,
      found: !!found,
      keyInfo: found ? {
        keyPrefix:   found.keyPrefix,
        environment: found.environment,
        status:      found.status,
        createdAt:   found.createdAt,
      } : null,
      message: found
        ? found.status === "active" ? "✅ Key found and active — auth should work" : "⚠️ Key found but REVOKED"
        : "❌ Key NOT in database — generate a new key from the dashboard",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PROTECTED routes ───────────────────────────────────────────────────────────
router.use(authMiddleware);

router.get("/", listApiKeys);
router.post("/", createApiKey);
router.patch("/:id/revoke", revokeApiKey);
router.delete("/:id", deleteApiKey);

export default router;
