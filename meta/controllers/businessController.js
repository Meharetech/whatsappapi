import WABAccount from "../models/WABAccount.js";
import PhoneNumber from "../models/PhoneNumber.js";
import MetaUser from "../models/MetaUser.js";
import MetaApiService from "../services/MetaApiService.js";

async function getUserToken(userId) {
  const metaUser = await MetaUser.findOne({ userId }).select("+longLivedToken");
  if (!metaUser?.longLivedToken) {
    throw new Error("Facebook not connected. Please connect your Facebook account first.");
  }
  return metaUser.longLivedToken;
}

// GET /api/meta/business
export async function getBusinesses(req, res) {
  try {
    const accounts = await WABAccount.find({ userId: req.user._id, status: { $ne: "disconnected" } })
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: accounts });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/business/sync
// Fetches WABAs from Meta and upserts them
export async function syncBusinesses(req, res) {
  try {
    const token = await getUserToken(req.user._id);
    const wabas = await MetaApiService.getWABAs(token);

    const results = [];
    for (const waba of wabas) {
      const account = await WABAccount.findOneAndUpdate(
        { wabaId: waba.id },
        {
          userId: req.user._id,
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
        { upsert: true, new: true }
      );
      results.push(account);
    }

    res.json({ success: true, data: results, synced: results.length });
  } catch (err) {
    console.error("[Business] syncBusinesses:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// POST /api/meta/business
// Manually add WABA by code (from embedded signup) or existing WABA ID
export async function connectBusiness(req, res) {
  try {
    const { code, wabaId, accessToken: rawToken } = req.body;

    let token = rawToken;

    if (code) {
      const tokenData = await MetaApiService.exchangeCodeForToken(code);
      token = tokenData.access_token;
    }

    if (!token) {
      const metaUser = await MetaUser.findOne({ userId: req.user._id }).select("+longLivedToken");
      token = metaUser?.longLivedToken;
    }

    if (!token) {
      return res.status(400).json({ success: false, error: "No access token available" });
    }

    if (wabaId) {
      const wabaInfo = await MetaApiService.getWABAInfo(wabaId, token);
      const account = await WABAccount.findOneAndUpdate(
        { wabaId: wabaInfo.id },
        {
          userId: req.user._id,
          wabaId: wabaInfo.id,
          businessName: wabaInfo.name,
          accessToken: token,
          currency: wabaInfo.currency,
          timezoneId: wabaInfo.timezone_id,
          messageTemplateNamespace: wabaInfo.message_template_namespace,
          status: "active",
        },
        { upsert: true, new: true }
      );
      return res.json({ success: true, data: account });
    }

    // Sync all WABAs
    req.user._id = req.user._id;
    const wabas = await MetaApiService.getWABAs(token);
    const results = [];
    for (const waba of wabas) {
      const account = await WABAccount.findOneAndUpdate(
        { wabaId: waba.id },
        {
          userId: req.user._id,
          wabaId: waba.id,
          businessAccountId: waba.businessAccountId,
          businessName: waba.name || waba.businessName,
          accessToken: token,
          status: "active",
        },
        { upsert: true, new: true }
      );
      results.push(account);
    }

    res.json({ success: true, data: results });
  } catch (err) {
    console.error("[Business] connectBusiness:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// GET /api/meta/business/:wabaId
export async function getBusinessById(req, res) {
  try {
    const account = await WABAccount.findOne({
      wabaId: req.params.wabaId,
      userId: req.user._id,
    }).lean();
    if (!account) return res.status(404).json({ success: false, error: "WABA not found" });
    res.json({ success: true, data: account });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// DELETE /api/meta/business/:wabaId
export async function disconnectBusiness(req, res) {
  try {
    await WABAccount.findOneAndUpdate(
      { wabaId: req.params.wabaId, userId: req.user._id },
      { status: "disconnected" }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
