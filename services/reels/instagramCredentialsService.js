import InstagramSession from "../../instagram/models/InstagramSession.js";
import instagramService from "../../instagram/services/InstagramService.js";

/**
 * Get Instagram credentials from user's connected session
 * Includes token refresh if expired
 * @param {string} userId - User ID
 * @returns {Promise<{accessToken: string, igUserId: string}>}
 */
export async function getInstagramCredentials(userId) {
  if (!userId) {
    throw new Error("User ID is required");
  }

  const session = await InstagramSession.findOne({ userId });

  if (!session) {
    throw new Error(
      "Instagram not connected. Connect your Instagram account in settings first.",
    );
  }

  // Try Graph API credentials first (new method)
  if (
    session.graph?.facebookUserAccessToken &&
    session.graph?.instagramBusinessAccountId
  ) {
    // Check if token is expired and refresh if needed
    let accessToken = session.graph.facebookUserAccessToken;

    if (session.graph?.facebookUserAccessTokenExpiresAt) {
      const expiryTime = new Date(
        session.graph.facebookUserAccessTokenExpiresAt,
      );
      const now = new Date();
      const timeUntilExpiry = expiryTime - now;

      // Refresh if within 24 hours of expiry
      if (timeUntilExpiry < 24 * 60 * 60 * 1000) {
        console.log(
          `[🔄 TOKEN REFRESH] Token expiring soon (${Math.floor(timeUntilExpiry / 3600000)}h left). Refreshing...`,
        );

        try {
          const newTokenData =
            await instagramService.getLongLivedToken(accessToken);
          accessToken = newTokenData.access_token;

          // Save refreshed token
          const newExpiry = new Date(
            Date.now() + (newTokenData.expires_in || 5184000) * 1000,
          );
          session.graph.facebookUserAccessToken = accessToken;
          session.graph.facebookUserAccessTokenExpiresAt = newExpiry;
          await session.save();

          console.log(
            `[✅ TOKEN REFRESH] Token refreshed successfully. New expiry: ${newExpiry}`,
          );
        } catch (err) {
          console.error(
            `[❌ TOKEN REFRESH] Failed to refresh token:`,
            err.message,
          );
          // Continue with old token - it might still be valid
        }
      }
    }

    return {
      accessToken,
      igUserId: session.graph.instagramBusinessAccountId,
      method: "graph",
    };
  }

  // Fallback to manual Instagram Business Account ID if set
  if (
    session.graph?.facebookUserAccessToken &&
    session.graph?.manualInstagramBusinessAccountId
  ) {
    let accessToken = session.graph.facebookUserAccessToken;

    // Also check expiry for manual mode
    if (session.graph?.facebookUserAccessTokenExpiresAt) {
      const expiryTime = new Date(
        session.graph.facebookUserAccessTokenExpiresAt,
      );
      const now = new Date();
      const timeUntilExpiry = expiryTime - now;

      if (timeUntilExpiry < 24 * 60 * 60 * 1000) {
        console.log(
          `[🔄 TOKEN REFRESH] Manual token expiring soon. Refreshing...`,
        );
        try {
          const newTokenData =
            await instagramService.getLongLivedToken(accessToken);
          accessToken = newTokenData.access_token;
          const newExpiry = new Date(
            Date.now() + (newTokenData.expires_in || 5184000) * 1000,
          );
          session.graph.facebookUserAccessToken = accessToken;
          session.graph.facebookUserAccessTokenExpiresAt = newExpiry;
          await session.save();
        } catch (err) {
          console.error(
            `[❌ TOKEN REFRESH] Failed to refresh token:`,
            err.message,
          );
        }
      }
    }

    return {
      accessToken,
      igUserId: session.graph.manualInstagramBusinessAccountId,
      method: "manual",
    };
  }

  throw new Error(
    "Instagram credentials incomplete. Please reconnect your Instagram account.",
  );
}

/**
 * Validate Instagram credentials are available
 * @param {string} userId - User ID
 * @returns {Promise<boolean>}
 */
export async function hasInstagramCredentials(userId) {
  try {
    const session = await InstagramSession.findOne({ userId });
    if (!session) return false;

    return !!(
      session.graph?.facebookUserAccessToken &&
      (session.graph?.instagramBusinessAccountId ||
        session.graph?.manualInstagramBusinessAccountId)
    );
  } catch (err) {
    return false;
  }
}
