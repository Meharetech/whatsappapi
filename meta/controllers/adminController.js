import MetaUser from "../models/MetaUser.js";
import WABAccount from "../models/WABAccount.js";
import PhoneNumber from "../models/PhoneNumber.js";
import MessageTemplate from "../models/MessageTemplate.js";
import MetaMessage from "../models/MetaMessage.js";
import MetaCampaign from "../models/MetaCampaign.js";
import MetaSystemSettings from "../models/MetaSystemSettings.js";
import User from "../../models/User.js";

function ensureAdmin(req, res) {
  if (!["admin", "superadmin"].includes(req.user?.role)) {
    res.status(403).json({ success: false, error: "Admin access required" });
    return false;
  }
  return true;
}

// GET /api/meta/admin/users
export async function getUsers(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { page = 1, limit = 30, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const metaUsers = await MetaUser.find({}).sort("-createdAt").lean();
    const userIds = metaUsers.map((u) => u.userId);
    const users = await User.find({ _id: { $in: userIds } }).lean();

    const userMap = {};
    users.forEach((u) => (userMap[String(u._id)] = u));

    const result = metaUsers.map((mu) => ({
      ...mu,
      user: userMap[String(mu.userId)] || null,
    }));

    res.json({ success: true, data: result, total: result.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/admin/businesses
export async function getBusinesses(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const accounts = await WABAccount.find({})
      .populate("userId", "name email")
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: accounts, total: accounts.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// PUT /api/meta/admin/businesses/:wabaId/status
export async function setBusinessStatus(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { status } = req.body;
    await WABAccount.findOneAndUpdate({ wabaId: req.params.wabaId }, { status });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/admin/messages
export async function getMessages(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { page = 1, limit = 50, status, userId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = userId;

    const skip = (Number(page) - 1) * Number(limit);
    const [messages, total] = await Promise.all([
      MetaMessage.find(filter)
        .populate("userId", "name email")
        .sort("-createdAt")
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      MetaMessage.countDocuments(filter),
    ]);
    res.json({ success: true, data: messages, total });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/admin/templates
export async function getTemplates(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { status, isFlagged } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (isFlagged !== undefined) filter.isFlagged = isFlagged === "true";

    const templates = await MessageTemplate.find(filter)
      .populate("userId", "name email")
      .populate("wabaId", "businessName wabaId")
      .sort("-createdAt")
      .lean();
    res.json({ success: true, data: templates, total: templates.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// PUT /api/meta/admin/templates/:id/moderate
export async function moderateTemplate(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const { action, adminNote } = req.body; // action: 'flag' | 'unflag' | 'reject'
    const update = { adminNote: adminNote || "" };
    if (action === "flag") update.isFlagged = true;
    if (action === "unflag") update.isFlagged = false;
    if (action === "reject") update.status = "REJECTED";

    const template = await MessageTemplate.findByIdAndUpdate(req.params.id, update, { new: true });
    res.json({ success: true, data: template });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/admin/analytics
export async function getAnalytics(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const [
      totalUsers,
      totalWABAs,
      activeWABAs,
      totalMessages,
      totalTemplates,
      approvedTemplates,
      pendingTemplates,
      totalCampaigns,
    ] = await Promise.all([
      MetaUser.countDocuments({ isConnected: true }),
      WABAccount.countDocuments(),
      WABAccount.countDocuments({ status: "active" }),
      MetaMessage.countDocuments(),
      MessageTemplate.countDocuments(),
      MessageTemplate.countDocuments({ status: "APPROVED" }),
      MessageTemplate.countDocuments({ status: "PENDING" }),
      MetaCampaign.countDocuments(),
    ]);

    const messagesByStatus = await MetaMessage.aggregate([
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);

    const statusMap = {};
    messagesByStatus.forEach((s) => (statusMap[s._id] = s.count));

    res.json({
      success: true,
      data: {
        totalUsers,
        totalWABAs,
        activeWABAs,
        totalMessages,
        messagesByStatus: statusMap,
        totalTemplates,
        approvedTemplates,
        pendingTemplates,
        totalCampaigns,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/meta/admin/settings
export async function getSettings(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const settings = await MetaSystemSettings.findOne().select("+metaAppSecret");
    res.json({ success: true, data: settings || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// PUT /api/meta/admin/settings
export async function updateSettings(req, res) {
  if (!ensureAdmin(req, res)) return;
  try {
    const allowed = [
      "metaAppId", "metaAppSecret", "webhookVerifyToken", "webhookUrl",
      "apiVersion", "embeddedSignupConfigId", "allowNewRegistrations",
      "maxWABAsPerUser", "rateLimitPerMinute", "maintenanceMode",
    ];
    const update = {};
    allowed.forEach((k) => { if (req.body[k] !== undefined) update[k] = req.body[k]; });

    const settings = await MetaSystemSettings.findOneAndUpdate(
      {},
      update,
      { upsert: true, new: true }
    );
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
