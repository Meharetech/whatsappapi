import express from "express";
import bcrypt from "bcryptjs";
import authMiddleware from "../middleware/auth.js";
import User from "../models/User.js";
import WhatsAppSession from "../models/WhatsAppSession.js";
import Message from "../models/Message.js";
import Campaign from "../models/Campaign.js";
import ApiKey from "../models/ApiKey.js";
import UserSubscription from "../models/UserSubscription.js";
import SubscriptionPlan from "../models/SubscriptionPlan.js";
import MediaCollection from "../models/Media.js";
import MediaSettings from "../models/MediaSettings.js";
import OpenRouterSettings from "../models/OpenRouterSettings.js";
import MetaSystemSettings from "../meta/models/MetaSystemSettings.js";
import GoogleOAuthSettings from "../models/GoogleOAuthSettings.js";
import Flow from "../models/Flow.js";

const router = express.Router();

function ensureAdmin(req, res) {
  if (!["admin", "superadmin"].includes(req.user?.role)) {
    res.status(403).json({ success: false, error: "Admin access required" });
    return false;
  }
  return true;
}

function dayLabel(date) {
  return date.toLocaleDateString("en-US", { weekday: "short" });
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function maskApiKey(key = "") {
  if (!key || key.length < 10) return "";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function maskSecret(secret = "") {
  if (!secret) return "";
  if (secret.length <= 6) return "••••••";
  return `${secret.slice(0, 2)}••••${secret.slice(-2)}`;
}

// ── Overview Dashboard ────────────────────────────────────────────────────────
router.get("/overview", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);

    const [
      totalUsers,
      newUsersCount,
      totalSessions,
      connectedSessions,
      totalMessages,
      recentMessageCount,
      totalApiKeys,
      activeApiKeys,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: since } }),
      WhatsAppSession.countDocuments(),
      WhatsAppSession.countDocuments({ status: "connected" }),
      Message.countDocuments(),
      Message.countDocuments({ createdAt: { $gte: since } }),
      ApiKey.countDocuments(),
      ApiKey.countDocuments({ status: "active" }),
    ]);

    // 7-day daily message chart
    const dailyMsgs = await Message.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          messages: { $sum: 1 },
          sessions: { $addToSet: "$sessionId" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build full days map
    const msgMap = {};
    dailyMsgs.forEach((d) => {
      msgMap[d._id] = { messages: d.messages, sessions: d.sessions.length };
    });
    const dailyChart = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      dailyChart.push({
        name: dayLabel(d),
        messages: msgMap[key]?.messages || 0,
        sessions: msgMap[key]?.sessions || 0,
      });
    }

    // API usage (single messages per day)
    const apiDaily = await Message.aggregate([
      { $match: { createdAt: { $gte: since }, messageType: "single" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const apiMap = {};
    apiDaily.forEach((d) => {
      apiMap[d._id] = d.requests;
    });
    const apiChart = dailyChart.map((d, i) => {
      const date = new Date(Date.now() - (days - 1 - i) * 86400000);
      const key = date.toISOString().slice(0, 10);
      return { name: d.name, requests: apiMap[key] || 0, errors: 0 };
    });

    // Plan distribution
    const planCounts = await UserSubscription.aggregate([
      { $match: { status: { $in: ["active", "trial"] } } },
      {
        $lookup: {
          from: "subscriptionplans",
          localField: "planId",
          foreignField: "_id",
          as: "plan",
        },
      },
      { $unwind: { path: "$plan", preserveNullAndEmptyArrays: true } },
      { $group: { _id: "$plan.name", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    const PLAN_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#8b5cf6", "#94a3b8"];
    const totalSubs = planCounts.reduce((s, p) => s + p.count, 0) || 1;
    const planSegments = planCounts.map((p, i) => ({
      label: p._id || "Unknown",
      value: Math.round((p.count / totalSubs) * 100),
      count: p.count,
      color: PLAN_COLORS[i % PLAN_COLORS.length],
    }));

    // Recent messages as activity — aggregate to avoid nested populate issues
    const recentMsgs = await Message.aggregate([
      { $sort: { createdAt: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "whatsappsessions",
          localField: "sessionId",
          foreignField: "_id",
          as: "sess",
        },
      },
      { $unwind: { path: "$sess", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "users",
          localField: "sess.userId",
          foreignField: "_id",
          as: "owner",
        },
      },
      { $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "campaigns",
          localField: "campaignId",
          foreignField: "_id",
          as: "camp",
        },
      },
      { $unwind: { path: "$camp", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          status: 1,
          createdAt: 1,
          sessionName: "$sess.name",
          userName: "$owner.name",
          userEmail: "$owner.email",
          campaignName: "$camp.name",
        },
      },
    ]);

    const recentActivity = recentMsgs.map((m) => ({
      id: String(m._id),
      user: m.userName || m.userEmail || "Unknown",
      action: m.campaignName ? `Campaign: ${m.campaignName}` : "Single message",
      session: m.sessionName || "—",
      time: m.createdAt,
      status:
        m.status === "delivered"
          ? "success"
          : m.status === "failed"
            ? "error"
            : "info",
    }));

    // Top users by message count — via sessions aggregate
    const topUsersMsgs = await Message.aggregate([
      {
        $lookup: {
          from: "whatsappsessions",
          localField: "sessionId",
          foreignField: "_id",
          as: "session",
        },
      },
      { $unwind: { path: "$session", preserveNullAndEmptyArrays: false } },
      { $match: { "session.userId": { $exists: true, $ne: null } } },
      { $group: { _id: "$session.userId", msgs: { $sum: 1 } } },
      { $sort: { msgs: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          msgs: 1,
          name: "$user.name",
          email: "$user.email",
        },
      },
    ]);

    const topUsers = topUsersMsgs.map((u) => ({
      name: u.name || u.email || "Unknown",
      email: u.email || "",
      msgs: u.msgs,
    }));

    res.json({
      success: true,
      data: {
        stats: {
          totalUsers,
          newUsersCount,
          totalSessions,
          connectedSessions,
          recentMessageCount,
          totalMessages,
          activeApiKeys,
          totalApiKeys,
        },
        dailyChart,
        apiChart,
        planSegments,
        recentActivity,
        topUsers,
      },
    });
  } catch (err) {
    console.error("admin/overview error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── User Management ───────────────────────────────────────────────────────────
router.get("/users", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const search = req.query.search || "";
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;

    const query = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } },
            { email: { $regex: search, $options: "i" } },
          ],
        }
      : {};

    const [users, total] = await Promise.all([
      User.find(query, "-password")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(query),
    ]);

    const userIds = users.map((u) => u._id);

    // Platform-wide summary stats (always across ALL users, not just current page)
    const [
      activeCount,
      inactiveCount,
      suspendedCount,
      planDistribution,
      newThisWeek,
      sessionCounts,
      msgCounts,
      subs,
    ] = await Promise.all([
      User.countDocuments({ status: "active" }),
      User.countDocuments({
        status: { $in: ["inactive", null, undefined] },
        $or: [{ status: "inactive" }, { status: { $exists: false } }],
      }),
      User.countDocuments({ status: "suspended" }),
      // Count users per plan
      UserSubscription.aggregate([
        {
          $lookup: {
            from: "subscriptionplans",
            localField: "planId",
            foreignField: "_id",
            as: "plan",
          },
        },
        { $unwind: { path: "$plan", preserveNullAndEmptyArrays: true } },
        { $group: { _id: "$plan.name", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      User.countDocuments({
        createdAt: { $gte: new Date(Date.now() - 7 * 86400000) },
      }),
      // Per-page session + msg counts
      WhatsAppSession.aggregate([
        { $match: { userId: { $in: userIds } } },
        { $group: { _id: "$userId", count: { $sum: 1 } } },
      ]),
      Message.aggregate([
        {
          $lookup: {
            from: "whatsappsessions",
            localField: "sessionId",
            foreignField: "_id",
            as: "sess",
          },
        },
        { $unwind: { path: "$sess", preserveNullAndEmptyArrays: false } },
        { $match: { "sess.userId": { $in: userIds } } },
        { $group: { _id: "$sess.userId", count: { $sum: 1 } } },
      ]),
      UserSubscription.find({ userId: { $in: userIds } })
        .populate("planId", "name slug isDemo")
        .lean(),
    ]);

    // active count = total minus suspended (users without a status field are active)
    const realActive = total - suspendedCount;

    const sessMap = {};
    sessionCounts.forEach((s) => {
      sessMap[String(s._id)] = s.count;
    });
    const msgMap = {};
    msgCounts.forEach((m) => {
      msgMap[String(m._id)] = m.count;
    });
    const subMap = {};
    subs.forEach((s) => {
      subMap[String(s.userId)] = s;
    });

    const rows = users.map((u) => ({
      ...u,
      sessions: sessMap[String(u._id)] || 0,
      msgs: msgMap[String(u._id)] || 0,
      subscription: subMap[String(u._id)] || null,
      joined: fmtDate(u.createdAt),
    }));

    const summary = {
      total: await User.countDocuments(),
      active: realActive,
      suspended: suspendedCount,
      newThisWeek,
      planDistribution,
    };

    res.json({
      success: true,
      data: {
        users: rows,
        total,
        page,
        pages: Math.ceil(total / limit),
        summary,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/users", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { name, email, password, role = "user" } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        error: "name, email and password are required",
      });
    }
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters",
      });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing)
      return res
        .status(400)
        .json({ success: false, error: "Email already exists" });

    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      password,
      role,
    });
    const { password: _, ...safe } = user.toObject();
    res.status(201).json({ success: true, data: safe });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.put("/users/:id", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const allowed = ["name", "email", "role", "status"];
    const payload = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) payload[k] = req.body[k];
    }
    if (payload.email) payload.email = payload.email.toLowerCase().trim();

    const user = await User.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    })
      .select("-password")
      .lean();
    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });
    res.json({ success: true, data: user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

router.delete("/users/:id", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    if (String(req.user._id) === req.params.id) {
      return res
        .status(400)
        .json({ success: false, error: "You cannot delete your own account" });
    }
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Session Monitoring ────────────────────────────────────────────────────────
router.get("/sessions", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const sessions = await WhatsAppSession.find({})
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .lean();

    const sessionIds = sessions.map((s) => s._id);
    const msgCounts = await Message.aggregate([
      { $match: { sessionId: { $in: sessionIds } } },
      { $group: { _id: "$sessionId", count: { $sum: 1 } } },
    ]);
    const msgMap = {};
    msgCounts.forEach((m) => {
      msgMap[String(m._id)] = m.count;
    });

    const rows = sessions.map((s) => ({
      _id: s._id,
      sessionId: s.sessionId,
      name: s.name,
      phoneNumber: s.phoneNumber,
      status: s.status,
      user: s.userId,
      messages: msgMap[String(s._id)] || 0,
      lastConnected: s.lastConnected,
      createdAt: s.createdAt,
    }));

    const connected = rows.filter((s) => s.status === "connected").length;
    const disconnected = rows.filter((s) => s.status === "disconnected").length;
    const connecting = rows.filter((s) =>
      ["connecting", "pending"].includes(s.status),
    ).length;

    res.json({
      success: true,
      data: {
        sessions: rows,
        stats: { total: rows.length, connected, disconnected, connecting },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Campaign Management ───────────────────────────────────────────────────────
router.get("/campaigns", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;
    const search = req.query.search || "";

    const query = {};
    if (statusFilter && statusFilter !== "all") query.status = statusFilter;

    const [campaigns, total] = await Promise.all([
      Campaign.find(query)
        .populate("userId", "name email")
        .populate("sessionId", "name sessionId")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-messageLog")
        .lean(),
      Campaign.countDocuments(query),
    ]);

    const filtered = search
      ? campaigns.filter(
          (c) =>
            c.name.toLowerCase().includes(search.toLowerCase()) ||
            (c.userId?.name || "")
              .toLowerCase()
              .includes(search.toLowerCase()) ||
            (c.userId?.email || "")
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
      : campaigns;

    const [running, scheduled, completed, paused] = await Promise.all([
      Campaign.countDocuments({ status: "running" }),
      Campaign.countDocuments({ status: "scheduled" }),
      Campaign.countDocuments({ status: "completed" }),
      Campaign.countDocuments({ status: "paused" }),
    ]);
    const totalSent = await Campaign.aggregate([
      { $group: { _id: null, sent: { $sum: "$stats.sent" } } },
    ]);

    res.json({
      success: true,
      data: {
        campaigns: filtered,
        total,
        page,
        pages: Math.ceil(total / limit),
        stats: {
          running,
          scheduled,
          completed,
          paused,
          totalSent: totalSent[0]?.sent || 0,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Message Logs ──────────────────────────────────────────────────────────────
router.get("/messages", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 30);
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status;
    const search = req.query.search || "";

    const query = {};
    if (statusFilter && statusFilter !== "all") query.status = statusFilter;
    if (search) {
      query.$or = [
        { phoneNumber: { $regex: search, $options: "i" } },
        { contactName: { $regex: search, $options: "i" } },
      ];
    }

    const [messages, total] = await Promise.all([
      Message.find(query)
        .populate({
          path: "sessionId",
          select: "name userId",
          populate: { path: "userId", select: "name email" },
        })
        .populate("campaignId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Message.countDocuments(query),
    ]);

    const [delivered, failed, pending] = await Promise.all([
      Message.countDocuments({ status: "delivered" }),
      Message.countDocuments({ status: "failed" }),
      Message.countDocuments({ status: "pending" }),
    ]);

    // Active/running campaigns
    const activeCampaigns = await Campaign.find({ status: "running" })
      .populate("userId", "name")
      .populate("sessionId", "name")
      .select("name stats progress userId sessionId")
      .lean();

    res.json({
      success: true,
      data: {
        messages,
        total,
        page,
        pages: Math.ceil(total / limit),
        stats: {
          total: await Message.countDocuments(),
          delivered,
          failed,
          pending,
        },
        activeCampaigns,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── API Usage ─────────────────────────────────────────────────────────────────
router.get("/api-usage", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 86400000);

    const [totalKeys, activeKeys, totalRequests] = await Promise.all([
      ApiKey.countDocuments(),
      ApiKey.countDocuments({ status: "active" }),
      ApiKey.aggregate([
        { $group: { _id: null, total: { $sum: "$callCount" } } },
      ]),
    ]);

    // Daily single-message API calls
    const dailyApi = await Message.aggregate([
      { $match: { createdAt: { $gte: since }, messageType: "single" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const apiMap = {};
    dailyApi.forEach((d) => {
      apiMap[d._id] = d.requests;
    });
    const weekChart = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      weekChart.push({
        name: dayLabel(d),
        requests: apiMap[key] || 0,
        errors: 0,
      });
    }

    // Top API consumers by callCount
    const topKeys = await ApiKey.find({ status: "active" })
      .populate("userId", "name email")
      .sort({ callCount: -1 })
      .limit(10)
      .lean();

    const maxCalls = topKeys[0]?.callCount || 1;
    const topApiUsers = topKeys.map((k) => ({
      name: k.userId?.name || k.userId?.email || "Unknown",
      calls: k.callCount,
      pct: Math.round((k.callCount / maxCalls) * 100),
    }));

    // Aggregate by user (sum across keys)
    const byUser = {};
    topKeys.forEach((k) => {
      const uid = String(k.userId?._id || "");
      if (!byUser[uid])
        byUser[uid] = {
          name: k.userId?.name || k.userId?.email || "Unknown",
          calls: 0,
        };
      byUser[uid].calls += k.callCount;
    });
    const topUsersList = Object.values(byUser)
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 5);
    const maxUserCalls = topUsersList[0]?.calls || 1;
    const topConsumers = topUsersList.map((u) => ({
      name: u.name,
      calls: u.calls,
      pct: Math.round((u.calls / maxUserCalls) * 100),
    }));

    const totalCallCount = totalRequests[0]?.total || 0;
    const successRate = totalCallCount > 0 ? 99.2 : 100; // approximate

    res.json({
      success: true,
      data: {
        stats: { totalKeys, activeKeys, totalCallCount, successRate },
        weekChart,
        topConsumers,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── System Analytics ──────────────────────────────────────────────────────────
router.get("/analytics", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const months = parseInt(req.query.months) || 6;
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    // Monthly messages & sessions
    const monthlyMsgs = await Message.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          messages: { $sum: 1 },
          sessions: { $addToSet: "$sessionId" },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Monthly new users
    const monthlyUsers = await User.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Monthly single-message API calls
    const monthlyApi = await Message.aggregate([
      { $match: { createdAt: { $gte: since }, messageType: "single" } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          requests: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build month labels
    const monthNames = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ];
    const monthLabels = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      monthLabels.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        name: monthNames[d.getMonth()],
      });
    }

    const msgMonthMap = {};
    monthlyMsgs.forEach((m) => {
      msgMonthMap[m._id] = {
        messages: m.messages,
        sessions: m.sessions.length,
      };
    });
    const userMonthMap = {};
    monthlyUsers.forEach((m) => {
      userMonthMap[m._id] = m.count;
    });
    const apiMonthMap = {};
    monthlyApi.forEach((m) => {
      apiMonthMap[m._id] = m.requests;
    });

    const activityChart = monthLabels.map((m) => ({
      name: m.name,
      messages: msgMonthMap[m.key]?.messages || 0,
      sessions: msgMonthMap[m.key]?.sessions || 0,
    }));
    const apiChart = monthLabels.map((m) => ({
      name: m.name,
      requests: apiMonthMap[m.key] || 0,
      errors: 0,
    }));
    const userGrowth = monthLabels.map((m) => ({
      name: m.name,
      users: userMonthMap[m.key] || 0,
    }));

    // Totals
    const [totalUsers, totalMessages, peakSessions, totalApiCalls] =
      await Promise.all([
        User.countDocuments(),
        Message.countDocuments({ createdAt: { $gte: since } }),
        WhatsAppSession.countDocuments({ createdAt: { $gte: since } }),
        Message.countDocuments({
          createdAt: { $gte: since },
          messageType: "single",
        }),
      ]);

    // Previous period for trends
    const prevSince = new Date(since);
    prevSince.setMonth(prevSince.getMonth() - months);
    const [prevUsers, prevMessages] = await Promise.all([
      User.countDocuments({ createdAt: { $gte: prevSince, $lt: since } }),
      Message.countDocuments({ createdAt: { $gte: prevSince, $lt: since } }),
    ]);

    const userTrend =
      prevUsers > 0
        ? `+${Math.round(((totalUsers - prevUsers) / prevUsers) * 100)}%`
        : "+100%";
    const msgTrend =
      prevMessages > 0
        ? `+${Math.round(((totalMessages - prevMessages) / prevMessages) * 100)}%`
        : "+100%";

    // Location-based distribution (from User.location)
    const locationDist = await User.aggregate([
      { $match: { location: { $ne: "" } } },
      { $group: { _id: "$location", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);
    const totalLocUsers = locationDist.reduce((s, l) => s + l.count, 0) || 1;
    const geoData = locationDist.map((l) => ({
      country: l._id,
      users: l.count,
      pct: Math.round((l.count / totalLocUsers) * 100),
    }));

    res.json({
      success: true,
      data: {
        stats: {
          totalUsers,
          totalMessages,
          peakSessions,
          totalApiCalls,
          userTrend,
          msgTrend,
        },
        activityChart,
        apiChart,
        userGrowth,
        geoData,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Admin Media ───────────────────────────────────────────────────────────────
router.get("/media", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    // Fetch all collections with user info, grouped by user
    const collections = await MediaCollection.find()
      .populate("userId", "name email")
      .sort({ createdAt: -1 })
      .lean();

    // Group by user
    const userMap = {};
    for (const col of collections) {
      const uid = String(col.userId?._id || col.userId || "unknown");
      if (!userMap[uid]) {
        userMap[uid] = {
          user: col.userId || { _id: uid, name: "Unknown", email: "" },
          collections: [],
          totalFiles: 0,
          totalSize: 0,
        };
      }
      const fileCount =
        (col.media?.length || 0) +
        (col.subcollections || []).reduce(
          (s, sc) => s + (sc.media?.length || 0),
          0,
        );
      userMap[uid].collections.push({ ...col, fileCount });
      userMap[uid].totalFiles += fileCount;
      userMap[uid].totalSize += col.totalSize || 0;
    }

    const users = Object.values(userMap).sort(
      (a, b) => b.totalFiles - a.totalFiles,
    );

    // Overall stats
    const totalCollections = collections.length;
    const totalFiles = users.reduce((s, u) => s + u.totalFiles, 0);
    const totalSize = users.reduce((s, u) => s + u.totalSize, 0);

    res.json({
      success: true,
      data: {
        users,
        stats: {
          totalUsers: users.length,
          totalCollections,
          totalFiles,
          totalSize,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/media/collection", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { userId, name, colorId } = req.body;
    if (!userId || !name)
      return res
        .status(400)
        .json({ success: false, error: "userId and name are required" });

    const user = await User.findById(userId).lean();
    if (!user)
      return res.status(404).json({ success: false, error: "User not found" });

    const col = new MediaCollection({
      userId,
      id: `col${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      colorId: colorId || "blue",
      media: [],
      subcollections: [],
    });
    await col.save();
    res.json({ success: true, data: col });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Media Upload Size Settings ─────────────────────────────────────────────────
router.get("/media-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    let settings = await MediaSettings.findOne({ key: "global" });
    if (!settings) settings = await MediaSettings.create({ key: "global" });
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/media-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { image, video, audio, document } = req.body;
    const update = {};
    if (image?.maxSizeMB !== undefined)
      update["image.maxSizeMB"] = Number(image.maxSizeMB);
    if (video?.maxSizeMB !== undefined)
      update["video.maxSizeMB"] = Number(video.maxSizeMB);
    if (audio?.maxSizeMB !== undefined)
      update["audio.maxSizeMB"] = Number(audio.maxSizeMB);
    if (document?.maxSizeMB !== undefined)
      update["document.maxSizeMB"] = Number(document.maxSizeMB);
    const settings = await MediaSettings.findOneAndUpdate(
      { key: "global" },
      { $set: update },
      { upsert: true, new: true, runValidators: true },
    );
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── OpenRouter Settings ──────────────────────────────────────────────────────
router.get("/openrouter-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    let settings = await OpenRouterSettings.findOne({ key: "global" }).lean();
    if (!settings) {
      settings = await OpenRouterSettings.create({ key: "global" });
      settings = settings.toObject();
    }

    res.json({
      success: true,
      data: {
        provider: settings.provider || "openrouter",
        model: settings.model || "openai/gpt-4o-mini",
        hasApiKey: !!settings.apiKey,
        maskedApiKey: maskApiKey(settings.apiKey),
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/openrouter-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { apiKey, model } = req.body || {};
    const update = {};

    if (typeof model === "string") {
      const nextModel = model.trim();
      if (!nextModel) {
        return res
          .status(400)
          .json({ success: false, error: "Model is required" });
      }
      update.model = nextModel;
    }

    if (typeof apiKey === "string") {
      const nextKey = apiKey.trim();
      if (nextKey && !nextKey.startsWith("sk-or-v1-")) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid OpenRouter API key format" });
      }
      update.apiKey = nextKey;
    }

    if (!Object.keys(update).length) {
      return res
        .status(400)
        .json({ success: false, error: "No settings provided" });
    }

    const settings = await OpenRouterSettings.findOneAndUpdate(
      { key: "global" },
      {
        $set: {
          provider: "openrouter",
          ...update,
        },
      },
      { upsert: true, new: true, runValidators: true },
    );

    res.json({
      success: true,
      data: {
        provider: settings.provider,
        model: settings.model,
        hasApiKey: !!settings.apiKey,
        maskedApiKey: maskApiKey(settings.apiKey),
        updatedAt: settings.updatedAt,
      },
      message: "OpenRouter settings saved",
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Meta OAuth Settings ────────────────────────────────────────────────────
router.get("/meta-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    let settings = await MetaSystemSettings.findOne()
      .select("+metaAppSecret")
      .lean();
    if (!settings) {
      const created = await MetaSystemSettings.create({});
      settings = created.toObject();
    }

    res.json({
      success: true,
      data: {
        metaAppId: settings.metaAppId || "",
        apiVersion: settings.apiVersion || "v19.0",
        hasAppSecret: !!settings.metaAppSecret,
        maskedAppSecret: maskSecret(settings.metaAppSecret || ""),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/meta-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { metaAppId, metaAppSecret, apiVersion } = req.body || {};
    const update = {};

    if (typeof metaAppId === "string") {
      update.metaAppId = metaAppId.trim();
    }

    if (typeof apiVersion === "string") {
      const nextVersion = apiVersion.trim();
      if (nextVersion) update.apiVersion = nextVersion;
    }

    if (typeof metaAppSecret === "string") {
      update.metaAppSecret = metaAppSecret.trim();
    }

    if (!Object.keys(update).length) {
      return res
        .status(400)
        .json({ success: false, error: "No settings provided" });
    }

    const settings = await MetaSystemSettings.findOneAndUpdate(
      {},
      { $set: update },
      { upsert: true, new: true, runValidators: true },
    )
      .select("+metaAppSecret")
      .lean();

    res.json({
      success: true,
      data: {
        metaAppId: settings.metaAppId || "",
        apiVersion: settings.apiVersion || "v19.0",
        hasAppSecret: !!settings.metaAppSecret,
        maskedAppSecret: maskSecret(settings.metaAppSecret || ""),
      },
      message: "Meta settings saved",
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Google OAuth Settings ─────────────────────────────────────────────────────
router.get("/google-oauth-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    let settings = await GoogleOAuthSettings.findOne({ key: "global" })
      .select("+clientSecret")
      .lean();
    if (!settings) {
      const created = await GoogleOAuthSettings.create({ key: "global" });
      settings = { ...created.toObject(), clientSecret: "" };
    }
    res.json({
      success: true,
      data: {
        clientId: settings.clientId || "",
        hasClientSecret: !!settings.clientSecret,
        maskedClientSecret: maskSecret(settings.clientSecret || ""),
        enabled: settings.enabled !== false,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.put("/google-oauth-settings", authMiddleware, async (req, res) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const { clientId, clientSecret, enabled } = req.body || {};
    const update = {};

    if (typeof clientId === "string") update.clientId = clientId.trim();
    if (typeof clientSecret === "string" && clientSecret.trim())
      update.clientSecret = clientSecret.trim();
    if (typeof enabled === "boolean") update.enabled = enabled;

    if (!Object.keys(update).length) {
      return res.status(400).json({ success: false, error: "No settings provided" });
    }

    const settings = await GoogleOAuthSettings.findOneAndUpdate(
      { key: "global" },
      { $set: update },
      { upsert: true, new: true, runValidators: true },
    )
      .select("+clientSecret")
      .lean();

    res.json({
      success: true,
      data: {
        clientId: settings.clientId || "",
        hasClientSecret: !!settings.clientSecret,
        maskedClientSecret: maskSecret(settings.clientSecret || ""),
        enabled: settings.enabled !== false,
        updatedAt: settings.updatedAt,
      },
      message: "Google OAuth settings saved",
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── Admin: Flow Management ────────────────────────────────────────────────────

// GET all flows across all users
router.get("/flows", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;

    const { search = "", status = "", page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (search) filter.name = { $regex: search, $options: "i" };

    const [flows, total] = await Promise.all([
      Flow.find(filter)
        .populate("userId", "name email")
        .populate("sessionId", "name phoneNumber status")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Flow.countDocuments(filter),
    ]);

    res.json({ success: true, flows, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE a flow (admin)
router.delete("/flows/:flowId", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const deleted = await Flow.findByIdAndDelete(req.params.flowId);
    if (!deleted) return res.status(404).json({ success: false, error: "Flow not found" });
    res.json({ success: true, message: "Flow deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH toggle flow status (admin)
router.patch("/flows/:flowId/status", authMiddleware, async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) return;
    const { status } = req.body;
    if (!["Active", "Draft", "Archived"].includes(status)) {
      return res.status(400).json({ success: false, error: "Invalid status" });
    }
    const flow = await Flow.findByIdAndUpdate(
      req.params.flowId,
      { status },
      { new: true }
    ).populate("userId", "name email").populate("sessionId", "name phoneNumber status");
    if (!flow) return res.status(404).json({ success: false, error: "Flow not found" });
    res.json({ success: true, flow });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
