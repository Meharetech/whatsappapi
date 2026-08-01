import MetaUser from "../models/MetaUser.js";
import MetaApiService from "../services/MetaApiService.js";
import MetaSystemSettings from "../models/MetaSystemSettings.js";
import WABAccount from "../models/WABAccount.js";
import PhoneNumber from "../models/PhoneNumber.js";

async function syncWABAsAndNumbers(userId, token) {
  const result = {
    wabasSynced: 0,
    numbersSynced: 0,
  };

  const wabas = await MetaApiService.getWABAs(token);
  for (const waba of wabas || []) {
    const account = await WABAccount.findOneAndUpdate(
      { wabaId: waba.id },
      {
        userId,
        wabaId: waba.id,
        businessAccountId: waba.businessAccountId,
        businessName: waba.name || waba.businessName,
        accessToken: token,
        currency: waba.currency,
        timezoneId: waba.timezone_id,
        messageTemplateNamespace: waba.message_template_namespace,
        onBehalfOfBusinessInfo: waba.on_behalf_of_business_info,
        status: "active",
      },
      { upsert: true, new: true },
    );
    result.wabasSynced += 1;

    try {
      const nums = await MetaApiService.getPhoneNumbers(waba.id, token);
      for (const num of nums.data || []) {
        await PhoneNumber.findOneAndUpdate(
          { phoneNumberId: num.id },
          {
            userId,
            wabaId: account._id,
            phoneNumberId: num.id,
            displayPhoneNumber: num.display_phone_number,
            verifiedName: num.verified_name,
            qualityRating: num.quality_rating || "UNKNOWN",
            status: num.status || "PENDING",
            codeVerificationStatus: num.code_verification_status || "UNVERIFIED",
            messagingLimitTier: num.messaging_limit_tier || "TIER_1K",
          },
          { upsert: true, new: true },
        );
        result.numbersSynced += 1;
      }
    } catch (err) {
      console.warn(
        `[MetaAuth] Could not sync phone numbers for WABA ${waba.id}:`,
        err.message,
      );
    }
  }

  return result;
}

// GET /api/meta/auth/config
// Safe public config for authenticated users (no secrets)
export async function getMetaOAuthConfig(req, res) {
  try {
    const settings = await MetaSystemSettings.findOne().lean();
    const metaAppId = String(settings?.metaAppId || "").trim();
    const embeddedSignupConfigId = String(
      settings?.embeddedSignupConfigId || "",
    ).trim();

    res.json({
      success: true,
      data: {
        metaAppId,
        apiVersion: String(settings?.apiVersion || "v19.0"),
        isConfigured: !!metaAppId,
        embeddedSignupConfigId,
        hasEmbeddedSignupConfig: !!embeddedSignupConfigId,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/auth/exchange-code
// Body: { code, redirectUri }
// Called by frontend after OAuth redirect returns with ?code=
export async function exchangeFacebookCode(req, res) {
  try {
    const { code, redirectUri } = req.body;
    if (!code || !redirectUri) {
      return res
        .status(400)
        .json({ success: false, error: "code and redirectUri are required" });
    }

    // Exchange code for short-lived token
    let tokenData;
    try {
      tokenData = await MetaApiService.exchangeCodeForToken(code, redirectUri);
    } catch (e) {
      return res
        .status(400)
        .json({ success: false, error: "Code exchange failed: " + e.message });
    }

    const shortLivedToken = tokenData.access_token;

    // Get profile
    let profile;
    try {
      profile = await MetaApiService.getUserProfile(shortLivedToken);
    } catch (e) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Could not fetch profile: " + e.message,
        });
    }

    // Upgrade to long-lived token (60 days)
    let longLivedToken = shortLivedToken;
    let expiresAt = null;
    try {
      const llData = await MetaApiService.getLongLivedToken(shortLivedToken);
      longLivedToken = llData.access_token;
      expiresAt = llData.expires_in
        ? new Date(Date.now() + llData.expires_in * 1000)
        : null;
    } catch (e) {
      console.warn("[MetaAuth] Long-lived token exchange failed:", e.message);
    }

    const metaUser = await MetaUser.findOneAndUpdate(
      { userId: req.user._id },
      {
        facebookId: profile.id,
        facebookName: profile.name || "",
        facebookEmail: profile.email || "",
        facebookPicture: profile.picture?.data?.url || "",
        longLivedToken,
        tokenExpiresAt: expiresAt,
        isConnected: true,
      },
      { upsert: true, new: true },
    );

    let sync = { wabasSynced: 0, numbersSynced: 0 };
    try {
      sync = await syncWABAsAndNumbers(req.user._id, longLivedToken);
    } catch (e) {
      console.warn("[MetaAuth] Auto sync after OAuth failed:", e.message);
    }

    res.json({
      success: true,
      profile: {
        facebookId: metaUser.facebookId,
        facebookName: metaUser.facebookName,
        facebookEmail: metaUser.facebookEmail,
        facebookPicture: metaUser.facebookPicture,
        isConnected: true,
        tokenExpiresAt: metaUser.tokenExpiresAt,
      },
      sync,
    });
  } catch (err) {
    console.error("[MetaAuth] exchangeFacebookCode:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/auth/facebook  (kept for direct token save if needed)
export async function saveFacebookToken(req, res) {
  try {
    const { accessToken } = req.body;
    if (!accessToken) {
      return res
        .status(400)
        .json({ success: false, error: "accessToken is required" });
    }

    // Exchange for long-lived token
    let longLivedData;
    try {
      longLivedData = await MetaApiService.getLongLivedToken(accessToken);
    } catch (e) {
      // If exchange fails (e.g., no app secret in dev), use short-lived token
      console.warn("[MetaAuth] Could not exchange token:", e.message);
      longLivedData = { access_token: accessToken, expires_in: 3600 };
    }

    // Get Facebook profile
    let profile;
    try {
      profile = await MetaApiService.getUserProfile(longLivedData.access_token);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: "Invalid access token: " + e.message,
      });
    }

    const expiresAt = longLivedData.expires_in
      ? new Date(Date.now() + longLivedData.expires_in * 1000)
      : null;

    // Upsert MetaUser
    const metaUser = await MetaUser.findOneAndUpdate(
      { userId: req.user._id },
      {
        facebookId: profile.id,
        facebookName: profile.name || "",
        facebookEmail: profile.email || "",
        facebookPicture: profile.picture?.data?.url || "",
        longLivedToken: longLivedData.access_token,
        tokenExpiresAt: expiresAt,
        isConnected: true,
      },
      { upsert: true, new: true },
    );

    let sync = { wabasSynced: 0, numbersSynced: 0 };
    try {
      sync = await syncWABAsAndNumbers(
        req.user._id,
        longLivedData.access_token,
      );
    } catch (e) {
      console.warn("[MetaAuth] Auto sync after token save failed:", e.message);
    }

    res.json({
      success: true,
      profile: {
        facebookId: metaUser.facebookId,
        facebookName: metaUser.facebookName,
        facebookEmail: metaUser.facebookEmail,
        facebookPicture: metaUser.facebookPicture,
        isConnected: metaUser.isConnected,
        tokenExpiresAt: metaUser.tokenExpiresAt,
      },
      sync,
    });
  } catch (err) {
    console.error("[MetaAuth] saveFacebookToken:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/auth/status
export async function getMetaStatus(req, res) {
  try {
    const metaUser = await MetaUser.findOne({ userId: req.user._id }).select(
      "+longLivedToken",
    );
    if (!metaUser || !metaUser.isConnected) {
      return res.json({ connected: false });
    }
    res.json({
      connected: true,
      facebookId: metaUser.facebookId,
      facebookName: metaUser.facebookName,
      facebookEmail: metaUser.facebookEmail,
      facebookPicture: metaUser.facebookPicture,
      tokenExpiresAt: metaUser.tokenExpiresAt,
      hasValidToken: metaUser.isTokenValid(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// DELETE /api/meta/auth/disconnect
export async function disconnectFacebook(req, res) {
  try {
    await MetaUser.findOneAndUpdate(
      { userId: req.user._id },
      { isConnected: false, longLivedToken: "", facebookId: null },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
