import express from "express";
import authController from "../controllers/authController.js";
import authMiddleware from "../middleware/auth.js";
import { User } from "../models/index.js";

const router = express.Router();

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/google-login", authController.googleLogin);
router.get("/me", authMiddleware, authController.getMe);
router.post("/update-password", authController.updatePassword);

// Admin setup endpoint - Set user role
router.post("/set-admin", authMiddleware, async (req, res) => {
  try {
    // Only superadmin or admin can set roles
    if (
      !req.user ||
      (req.user.role !== "admin" && req.user.role !== "superadmin")
    ) {
      return res.status(403).json({ error: "Only admins can set user roles" });
    }

    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: "Email and role are required" });
    }

    if (!["user", "admin", "superadmin"].includes(role)) {
      return res
        .status(400)
        .json({ error: "Invalid role. Must be user, admin, or superadmin" });
    }

    const user = await User.findOneAndUpdate(
      { email },
      { role },
      { new: true },
    );

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({
      message: `User ${email} role updated to ${role}`,
      user: user.toJSON(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users (admin only)
router.get("/users", authMiddleware, async (req, res) => {
  try {
    if (
      !req.user ||
      (req.user.role !== "admin" && req.user.role !== "superadmin")
    ) {
      return res.status(403).json({ error: "Only admins can view all users" });
    }

    const users = await User.find({}, "email name role createdAt").sort({
      createdAt: -1,
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
