import PhoneNumber from "../models/PhoneNumber.js";
import WABAccount from "../models/WABAccount.js";
import MetaApiService from "../services/MetaApiService.js";

async function getWABAWithToken(wabaDbId, userId) {
  const waba = await WABAccount.findOne({
    _id: wabaDbId,
    userId,
    status: "active",
  }).select("+accessToken");
  if (!waba) throw new Error("WABA not found or inactive");
  if (!waba.accessToken) throw new Error("No access token for this WABA");
  return waba;
}

// GET /api/meta/numbers
export async function getNumbers(req, res) {
  try {
    const { wabaId } = req.query;
    const filter = { userId: req.user._id };
    if (wabaId) {
      const waba = await WABAccount.findOne({ wabaId, userId: req.user._id });
      if (waba) filter.wabaId = waba._id;
    }
    const numbers = await PhoneNumber.find(filter)
      .populate("wabaId", "businessName wabaId")
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: numbers });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/numbers/sync/:wabaDbId
export async function syncNumbers(req, res) {
  try {
    const waba = await getWABAWithToken(req.params.wabaDbId, req.user._id);
    const result = await MetaApiService.getPhoneNumbers(waba.wabaId, waba.accessToken);

    const synced = [];
    for (const num of result.data || []) {
      const pn = await PhoneNumber.findOneAndUpdate(
        { phoneNumberId: num.id },
        {
          userId: req.user._id,
          wabaId: waba._id,
          phoneNumberId: num.id,
          displayPhoneNumber: num.display_phone_number,
          verifiedName: num.verified_name,
          qualityRating: num.quality_rating || "UNKNOWN",
          status: num.status || "PENDING",
          codeVerificationStatus: num.code_verification_status || "UNVERIFIED",
          messagingLimitTier: num.messaging_limit_tier || "TIER_1K",
        },
        { upsert: true, new: true }
      );
      synced.push(pn);
    }

    res.json({ success: true, data: synced, synced: synced.length });
  } catch (err) {
    console.error("[Numbers] syncNumbers:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// POST /api/meta/numbers/:id/display-name
// Body: { displayName, category }
export async function submitDisplayName(req, res) {
  try {
    const { displayName, category } = req.body;
    if (!displayName) return res.status(400).json({ success: false, error: "displayName required" });

    const phoneNumber = await PhoneNumber.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!phoneNumber) return res.status(404).json({ success: false, error: "Phone number not found" });

    const waba = await WABAccount.findById(phoneNumber.wabaId).select("+accessToken");
    if (!waba) return res.status(404).json({ success: false, error: "WABA not found" });

    await MetaApiService.submitDisplayName(
      phoneNumber.phoneNumberId,
      displayName,
      category || "OTHER",
      waba.accessToken
    );

    phoneNumber.displayNameSubmitted = displayName;
    phoneNumber.displayNameStatus = "PENDING";
    phoneNumber.displayNameCategory = category || "OTHER";
    await phoneNumber.save();

    res.json({ success: true, data: phoneNumber });
  } catch (err) {
    console.error("[Numbers] submitDisplayName:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// GET /api/meta/numbers/:id
export async function getNumberById(req, res) {
  try {
    const pn = await PhoneNumber.findOne({
      _id: req.params.id,
      userId: req.user._id,
    }).populate("wabaId", "businessName wabaId");
    if (!pn) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: pn });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
