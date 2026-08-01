import express from "express";
import bcrypt from "bcryptjs";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";
import Notification from "../models/Notification.js";
import MediaSettings from "../models/MediaSettings.js";
import GoogleOAuthSettings from "../models/GoogleOAuthSettings.js";
import UserGoogleConnection from "../models/UserGoogleConnection.js";
import OpenRouterSettings from "../models/OpenRouterSettings.js";

const router = express.Router();

// ── Media Upload Limits (public for all authenticated users) ─────────────────
router.get("/media-limits", authMiddleware, async (req, res) => {
  try {
    let settings = await MediaSettings.findOne({ key: "global" });
    if (!settings) settings = await MediaSettings.create({ key: "global" });
    res.json({
      success: true,
      data: {
        image: settings.image?.maxSizeMB ?? 10,
        video: settings.video?.maxSizeMB ?? 50,
        audio: settings.audio?.maxSizeMB ?? 20,
        document: settings.document?.maxSizeMB ?? 25,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Google OAuth Client ID (safe for all authenticated users) ────────────────
router.get("/google-client-id", authMiddleware, async (req, res) => {
  try {
    const settings = await GoogleOAuthSettings.findOne({
      key: "global",
    }).lean();
    const clientId = settings?.clientId || "";
    const enabled = settings?.enabled !== false;
    res.json({ success: true, data: { clientId, enabled } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Google Connection (persist OAuth token per user) ─────────────────────

router.get("/google-connection", authMiddleware, async (req, res) => {
  try {
    const conn = await UserGoogleConnection.findOne({ userId: req.user._id })
      .select("+accessToken")
      .lean();

    if (!conn || !conn.accessToken) {
      return res.json({ success: true, data: { connected: false } });
    }

    const isExpired = conn.expiresAt && new Date(conn.expiresAt) <= new Date();
    res.json({
      success: true,
      data: {
        connected: true,
        accessToken: conn.accessToken,
        expiresAt: conn.expiresAt,
        expired: isExpired,
        email: conn.email,
        name: conn.name,
        picture: conn.picture,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/google-connection", authMiddleware, async (req, res) => {
  try {
    const { accessToken, expiresIn, email, name, picture } = req.body || {};
    if (!accessToken) {
      return res
        .status(400)
        .json({ success: false, error: "accessToken required" });
    }

    const expiresAt = new Date(Date.now() + (Number(expiresIn) || 3600) * 1000);

    await UserGoogleConnection.findOneAndUpdate(
      { userId: req.user._id },
      {
        $set: {
          accessToken,
          expiresAt,
          email: email || "",
          name: name || "",
          picture: picture || "",
        },
      },
      { upsert: true, new: true },
    );

    res.json({ success: true, message: "Google connection saved" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/google-connection", authMiddleware, async (req, res) => {
  try {
    await UserGoogleConnection.deleteOne({ userId: req.user._id });
    res.json({ success: true, message: "Google connection removed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Profile ──────────────────────────────────────────────────────────────────

router.get("/profile", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });
    delete user.password;
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/profile", authMiddleware, async (req, res) => {
  try {
    const allowed = [
      "name",
      "phone",
      "company",
      "bio",
      "timezone",
      "language",
      "location",
    ];
    const payload = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) payload[key] = req.body[key];
    }

    // Email change — check uniqueness
    if (req.body.email && req.body.email !== req.user.email) {
      const existing = await User.findOne({
        email: req.body.email.toLowerCase().trim(),
      });
      if (existing)
        return res
          .status(400)
          .json({ success: false, error: "Email already in use" });
      payload.email = req.body.email.toLowerCase().trim();
    }

    const user = await User.findByIdAndUpdate(req.user._id, payload, {
      new: true,
      runValidators: true,
    }).lean();
    delete user.password;
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Password ─────────────────────────────────────────────────────────────────

router.put("/password", authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({
          success: false,
          error: "currentPassword and newPassword are required",
        });
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({
          success: false,
          error: "New password must be at least 8 characters",
        });
    }

    const user = await User.findById(req.user._id);
    const ok = await user.comparePassword(currentPassword);
    if (!ok)
      return res
        .status(400)
        .json({ success: false, error: "Current password is incorrect" });

    user.password = newPassword;
    await user.save();

    res.json({ success: true, message: "Password updated successfully" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Notification Preferences ──────────────────────────────────────────────────

router.get("/notifications/prefs", authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).lean();
    res.json({ success: true, data: user?.notificationPrefs || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/notifications/prefs", authMiddleware, async (req, res) => {
  try {
    const keys = [
      "sessionDisconnect",
      "deliveryFailures",
      "usageWarnings",
      "weeklySummary",
      "marketing",
    ];
    const update = {};
    for (const k of keys) {
      if (req.body[k] !== undefined)
        update[`notificationPrefs.${k}`] = !!req.body[k];
    }
    const user = await User.findByIdAndUpdate(req.user._id, update, {
      new: true,
    }).lean();
    res.json({ success: true, data: user?.notificationPrefs || {} });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Notification Inbox ────────────────────────────────────────────────────────

router.get("/notifications", authMiddleware, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const [items, total, unread] = await Promise.all([
      Notification.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Notification.countDocuments({ userId: req.user._id }),
      Notification.countDocuments({ userId: req.user._id, read: false }),
    ]);

    res.json({
      success: true,
      data: { items, total, unread, page, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/notifications/read-all", authMiddleware, async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true },
    );
    res.json({ success: true, message: "All notifications marked as read" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/notifications/:id/read", authMiddleware, async (req, res) => {
  try {
    await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { read: true },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/notifications/:id", authMiddleware, async (req, res) => {
  try {
    await Notification.findOneAndDelete({
      _id: req.params.id,
      userId: req.user._id,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Delete Account ────────────────────────────────────────────────────────────

router.delete("/account", authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password)
      return res
        .status(400)
        .json({ success: false, error: "Password confirmation required" });

    const user = await User.findById(req.user._id);
    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    const ok = await user.comparePassword(password);
    if (!ok)
      return res
        .status(400)
        .json({ success: false, error: "Incorrect password" });

    // Delete related data
    await Notification.deleteMany({ userId: req.user._id });
    await User.findByIdAndDelete(req.user._id);

    res.json({ success: true, message: "Account deleted" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── OpenRouter AI Settings ────────────────────────────────────────────────────

router.get("/openrouter", authMiddleware, async (req, res) => {
  try {
    let settings = await OpenRouterSettings.findOne({ key: "global" });
    if (!settings) {
      settings = await OpenRouterSettings.create({ key: "global" });
    }

    res.json({
      success: true,
      data: {
        apiKey: settings.apiKey ? "***" + settings.apiKey.slice(-4) : "", // Mask API key
        model: settings.model || "openai/gpt-4o-mini",
        provider: settings.provider || "openrouter",
        configured: !!settings.apiKey,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/openrouter", authMiddleware, async (req, res) => {
  try {
    const { apiKey, model } = req.body;

    if (!apiKey) {
      return res
        .status(400)
        .json({ success: false, error: "apiKey is required" });
    }

    const settings = await OpenRouterSettings.findOneAndUpdate(
      { key: "global" },
      {
        $set: {
          apiKey: apiKey.trim(),
          model: model || "openai/gpt-4o-mini",
          provider: "openrouter",
        },
      },
      { upsert: true, new: true },
    );

    console.log(
      `[✅ SETTINGS] OpenRouter API key saved (model: ${settings.model})`,
    );

    res.json({
      success: true,
      message: "OpenRouter settings saved",
      data: {
        apiKey: "***" + apiKey.slice(-4),
        model: settings.model,
        provider: settings.provider,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete("/openrouter", authMiddleware, async (req, res) => {
  try {
    await OpenRouterSettings.findOneAndUpdate(
      { key: "global" },
      { $set: { apiKey: "" } },
      { upsert: true },
    );

    console.log(`[✅ SETTINGS] OpenRouter API key removed`);

    res.json({ success: true, message: "OpenRouter API key removed" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
