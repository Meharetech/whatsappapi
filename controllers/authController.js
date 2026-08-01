import { User } from "../models/index.js";
import { generateToken } from "../utils/auth.js";
import SubscriptionService from "../services/SubscriptionService.js";
import {
  isFirebaseEmailPasswordVerified,
  verifyFirebaseIdToken,
} from "../utils/firebaseAdmin.js";

export const register = async (req, res) => {
  try {
    const { email, password, name, location, firebaseUid } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const user = new User({
      email,
      password,
      name: name || "",
      location: location || "",
      authProvider: "local",
      firebaseUid: firebaseUid || "",
      emailVerified: !firebaseUid,
    });
    await user.save();

    await SubscriptionService.ensureUserSubscription(user);

    const token = generateToken(user._id, user.role);

    res.status(201).json({
      user: user.toJSON(),
      token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.authProvider === "local" && user.firebaseUid) {
      const verification = await isFirebaseEmailPasswordVerified(
        email,
        password,
      );

      if (!verification.verified) {
        return res.status(403).json({
          error:
            "Please verify your email from Firebase verification link before login.",
        });
      }

      if (!user.emailVerified) {
        user.emailVerified = true;
        await user.save();
      }
    }

    await SubscriptionService.ensureUserSubscription(user);

    const token = generateToken(user._id, user.role);

    res.json({
      user: user.toJSON(),
      token,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({ error: "idToken is required" });
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch (err) {
      if (
        err?.message?.includes("Firebase Admin is not configured") ||
        err?.message?.includes("Firebase verification is not configured")
      ) {
        return res.status(500).json({
          error:
            "Firebase is not configured on server. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY or set FIREBASE_WEB_API_KEY.",
        });
      }
      return res.status(401).json({ error: "Invalid Firebase token" });
    }

    const email = (decoded.email || "").toLowerCase();
    if (!email) {
      return res.status(400).json({ error: "Google account email is missing" });
    }

    const firebaseUid = decoded.uid;
    const name = decoded.name || "";
    const picture = decoded.picture || "";
    const emailVerified = !!decoded.email_verified;

    let user = await User.findOne({ $or: [{ email }, { firebaseUid }] });

    if (!user) {
      user = new User({
        email,
        name,
        authProvider: "google",
        firebaseUid,
        googleEmailVerified: emailVerified,
        emailVerified: emailVerified,
        avatarUrl: picture,
      });
    } else {
      user.email = email;
      user.name = user.name || name;
      user.authProvider = "google";
      user.firebaseUid = firebaseUid;
      user.googleEmailVerified = emailVerified;
      user.emailVerified = emailVerified;
      user.avatarUrl = user.avatarUrl || picture;
    }

    await user.save();
    await SubscriptionService.ensureUserSubscription(user);

    const token = generateToken(user._id, user.role);

    return res.json({
      user: user.toJSON(),
      token,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

export const getMe = async (req, res) => {
  try {
    res.json({ user: req.user.toJSON() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const updatePassword = async (req, res) => {
  try {
    const { idToken, newPassword } = req.body;
    if (!idToken || !newPassword) {
      return res
        .status(400)
        .json({ error: "idToken and newPassword are required" });
    }
    if (newPassword.length < 6) {
      return res
        .status(400)
        .json({ error: "Password must be at least 6 characters" });
    }

    let decoded;
    try {
      decoded = await verifyFirebaseIdToken(idToken);
    } catch {
      return res.status(401).json({ error: "Invalid Firebase token" });
    }

    const user = await User.findOne({
      $or: [
        { firebaseUid: decoded.uid },
        { email: (decoded.email || "").toLowerCase() },
      ],
    });

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.authProvider !== "local") {
      return res
        .status(400)
        .json({ error: "Password reset is only available for local accounts" });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default { register, login, googleLogin, getMe, updatePassword };
