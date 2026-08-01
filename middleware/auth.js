import { getUserFromToken } from "../utils/auth.js";
import { findUserByApiKey } from "../controllers/apiKeyController.js";

const authMiddleware = async (req, res, next) => {
  try {
    // ── Check x-api-key header first ─────────────────────────────────────────
    const apiKeyHeader = (req.headers["x-api-key"] || "").trim();
    if (apiKeyHeader) {
      console.log(
        "\n🔐 [AUTH]",
        req.method,
        req.originalUrl,
        "| x-api-key[:20]:",
        apiKeyHeader.slice(0, 20),
      );
      const user = await findUserByApiKey(apiKeyHeader);
      if (!user) {
        return res.status(401).json({
          error: "API key not found or revoked",
          hint: "Generate a new key at /dashboard/api-keys",
        });
      }
      console.log(
        "🔐 [AUTH] ✅ API key OK — user:",
        String(user._id),
        user.email,
      );
      req.user = user;
      return next();
    }

    // ── Fall back to Authorization Bearer (JWT or API key) ───────────────────
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
      ? header.slice(7).trim()
      : header.trim();

    console.log(
      "\n🔐 [AUTH]",
      req.method,
      req.originalUrl,
      "| token[:20]:",
      token.slice(0, 20),
    );

    if (!token) {
      return res.status(401).json({
        error: "No authentication provided",
        hint: "Sign in to the app or send an Authorization: Bearer <token> header",
      });
    }

    // ── API key via Bearer ────────────────────────────────────────────────────
    if (token.startsWith("wac_live_") || token.startsWith("wac_test_")) {
      console.log("🔐 [AUTH] → API key path (Bearer)");
      const user = await findUserByApiKey(token);
      if (!user) {
        return res.status(401).json({
          error: "API key not found or revoked",
          hint: "Generate a new key at /dashboard/api-keys",
        });
      }
      console.log(
        "🔐 [AUTH] ✅ API key OK — user:",
        String(user._id),
        user.email,
      );
      req.user = user;
      return next();
    }

    // ── JWT path ──────────────────────────────────────────────────────────────
    console.log("🔐 [AUTH] → JWT path");
    const user = await getUserFromToken(token);
    if (!user) {
      return res.status(401).json({
        error: "JWT invalid or expired — please re-login",
        hint: "Refresh your login session and retry the request",
      });
    }

    console.log("🔐 [AUTH] ✅ JWT OK — user:", String(user._id), user.email);
    req.user = user;
    next();
  } catch (err) {
    console.error("🔐 [AUTH] 💥", err.message);
    return res
      .status(401)
      .json({ error: "Authentication failed", detail: err.message });
  }
};

export default authMiddleware;
