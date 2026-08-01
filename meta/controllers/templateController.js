import MessageTemplate from "../models/MessageTemplate.js";
import WABAccount from "../models/WABAccount.js";
import MetaApiService from "../services/MetaApiService.js";

async function getWABAWithToken(wabaDbId, userId) {
  const waba = await WABAccount.findOne({
    _id: wabaDbId,
    userId,
    status: "active",
  }).select("+accessToken");
  if (!waba) throw new Error("WABA not found or inactive");
  return waba;
}

// GET /api/meta/templates
export async function getTemplates(req, res) {
  try {
    const { wabaId, status, category } = req.query;
    const filter = { userId: req.user._id };
    if (wabaId) {
      const waba = await WABAccount.findOne({ wabaId, userId: req.user._id });
      if (waba) filter.wabaId = waba._id;
    }
    if (status) filter.status = status;
    if (category) filter.category = category;

    const templates = await MessageTemplate.find(filter)
      .populate("wabaId", "businessName wabaId")
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: templates });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/templates/:id
export async function getTemplateById(req, res) {
  try {
    const t = await MessageTemplate.findOne({ _id: req.params.id, userId: req.user._id })
      .populate("wabaId", "businessName wabaId");
    if (!t) return res.status(404).json({ success: false, error: "Not found" });
    res.json({ success: true, data: t });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/templates
// Body: { wabaId (db _id), name, language, category, components }
export async function createTemplate(req, res) {
  try {
    const { wabaId, name, language, category, components } = req.body;
    if (!wabaId || !name || !category || !components?.length) {
      return res.status(400).json({
        success: false,
        error: "wabaId, name, category and components are required",
      });
    }

    const waba = await getWABAWithToken(wabaId, req.user._id);

    // Submit to Meta
    let metaTemplateId = "";
    let status = "PENDING";
    try {
      const metaResult = await MetaApiService.createTemplate(
        waba.wabaId,
        { name: name.toLowerCase().replace(/\s+/g, "_"), language, category, components },
        waba.accessToken
      );
      metaTemplateId = metaResult.id || "";
      status = metaResult.status || "PENDING";
    } catch (e) {
      console.error("[Templates] Meta submission failed:", e.message);
      status = "DRAFT";
    }

    const template = await MessageTemplate.create({
      userId: req.user._id,
      wabaId,
      metaTemplateId,
      name: name.toLowerCase().replace(/\s+/g, "_"),
      language,
      category,
      components,
      status,
      lastSyncedAt: new Date(),
    });

    res.status(201).json({ success: true, data: template });
  } catch (err) {
    console.error("[Templates] createTemplate:", err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

// DELETE /api/meta/templates/:id
export async function deleteTemplate(req, res) {
  try {
    const template = await MessageTemplate.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!template) return res.status(404).json({ success: false, error: "Not found" });

    const waba = await getWABAWithToken(String(template.wabaId), req.user._id);

    try {
      await MetaApiService.deleteTemplate(waba.wabaId, template.name, waba.accessToken);
    } catch (e) {
      console.warn("[Templates] Meta delete failed:", e.message);
    }

    await template.deleteOne();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/meta/templates/:id/sync
export async function syncTemplate(req, res) {
  try {
    const template = await MessageTemplate.findOne({
      _id: req.params.id,
      userId: req.user._id,
    });
    if (!template) return res.status(404).json({ success: false, error: "Not found" });

    const waba = await getWABAWithToken(String(template.wabaId), req.user._id);

    const metaTemplates = await MetaApiService.getTemplates(waba.wabaId, waba.accessToken);
    const found = (metaTemplates.data || []).find((t) => t.name === template.name);

    if (found) {
      template.status = found.status;
      template.metaTemplateId = found.id;
      template.rejectionReason = found.rejected_reason || "";
      template.components = found.components || template.components;
      template.lastSyncedAt = new Date();
      await template.save();
    }

    res.json({ success: true, data: template });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}

// POST /api/meta/templates/sync-all
export async function syncAllTemplates(req, res) {
  try {
    const { wabaId } = req.body;
    const waba = await getWABAWithToken(wabaId, req.user._id);

    const metaTemplates = await MetaApiService.getTemplates(waba.wabaId, waba.accessToken);
    let synced = 0;

    for (const mt of metaTemplates.data || []) {
      await MessageTemplate.findOneAndUpdate(
        { name: mt.name, wabaId, userId: req.user._id },
        {
          metaTemplateId: mt.id,
          status: mt.status,
          language: mt.language,
          category: mt.category,
          components: mt.components || [],
          rejectionReason: mt.rejected_reason || "",
          lastSyncedAt: new Date(),
        },
        { upsert: true }
      );
      synced++;
    }

    res.json({ success: true, synced });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
}
