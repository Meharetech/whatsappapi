import jwt from "jsonwebtoken";
import { User } from "../models/index.js";

export const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("JWT_SECRET environment variable is not defined in production.");
    }
    return "dev-secret-key-whatsapp-campaign-2024";
  }
  return secret;
};

export const generateToken = (userId, role = "user") => {
  return jwt.sign({ userId, role }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, getJwtSecret());
  } catch (err) {
    console.log("🔑 [JWT] verify failed:", err.name, "-", err.message);
    return null;
  }
};

export const getUserFromToken = async (token) => {
  const decoded = verifyToken(token);
  if (!decoded) {
    console.log("🔑 [JWT] decoded is null — bad secret or expired");
    return null;
  }
  console.log(
    "🔑 [JWT] decoded userId:",
    decoded.userId,
    "| exp:",
    new Date(decoded.exp * 1000).toISOString(),
  );
  const user = await User.findById(decoded.userId);
  if (!user)
    console.log("🔑 [JWT] user not found in DB for id:", decoded.userId);
  return user;
};

export default { generateToken, verifyToken, getUserFromToken };
