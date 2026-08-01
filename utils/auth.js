import jwt from "jsonwebtoken";
import { User } from "../models/index.js";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key";

export const generateToken = (userId, role = "user") => {
  return jwt.sign({ userId, role }, JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

export const verifyToken = (token) => {
  try {
    return jwt.verify(token, JWT_SECRET);
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
