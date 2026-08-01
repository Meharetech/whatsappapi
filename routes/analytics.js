import express from "express";
import mongoose from "mongoose";
import authMiddleware from "../middleware/auth.js";
import Message from "../models/Message.js";
import Campaign from "../models/Campaign.js";
import { WhatsAppSession } from "../models/index.js";
import ApiKey from "../models/ApiKey.js";
import SubscriptionService from "../services/SubscriptionService.js";

const router = express.Router();

function startOfDay(d) {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
}

// GET /api/analytics/dashboard  — main user dashboard stats
router.get("/dashboard", authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;

    // Sessions
    const allSessions = await WhatsAppSession.find({ userId }).lean();
    const sessionIds = allSessions.map(s => s._id);

    // Messages: totals
    const [totalMessages, sentMessages, deliveredMessages, failedMessages, pendingMessages] = await Promise.all([
      Message.countDocuments({ sessionId: { $in: sessionIds } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, status: { $in: ["sent", "delivered", "read"] } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, status: { $in: ["delivered", "read"] } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, status: "failed" }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, status: "pending" }),
    ]);

    // Messages this week (last 7 days per day)
    const weekStart = daysAgo(6);
    const weekMsgs = await Message.aggregate([
      {
        $match: {
          sessionId: { $in: sessionIds },
          createdAt: { $gte: weekStart },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
          },
          messages: { $sum: 1 },
          sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Build 7-day array with day names
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const weekChart = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = weekMsgs.find(m => m._id === key);
      weekChart.push({
        name: dayNames[d.getDay()],
        date: key,
        messages: found?.messages || 0,
        sent: found?.sent || 0,
        failed: found?.failed || 0,
        sessions: allSessions.length,
      });
    }

    // Recent messages (last 5)
    const recentMessages = await Message.find({ sessionId: { $in: sessionIds } })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // Campaigns
    const totalCampaigns = await Campaign.countDocuments({ userId });
    const activeCampaigns = await Campaign.countDocuments({ userId, status: "running" });

    // API Keys
    const apiKeyCount = await ApiKey.countDocuments({ userId, status: "active" });

    // Subscription summary
    const subSummary = await SubscriptionService.getUsageSummary(userId);

    // Active sessions count (from WhatsApp service — approximate via DB status)
    const connectedSessions = allSessions.filter(s =>
      ["connected", "active"].includes(s.status)
    ).length;

    // Delivery rate
    const deliveryRate = sentMessages > 0
      ? Math.round((deliveredMessages / sentMessages) * 1000) / 10
      : 0;

    res.json({
      success: true,
      data: {
        stats: {
          totalMessages,
          sentMessages,
          deliveredMessages,
          failedMessages,
          pendingMessages,
          totalSessions: allSessions.length,
          connectedSessions,
          totalCampaigns,
          activeCampaigns,
          apiKeyCount,
          deliveryRate,
        },
        weekChart,
        recentMessages: recentMessages.map(m => ({
          _id: m._id,
          phoneNumber: m.phoneNumber,
          contactName: m.contactName,
          message: m.message,
          status: m.status,
          createdAt: m.createdAt,
          sentAt: m.sentAt,
        })),
        sessions: allSessions.map(s => ({
          _id: s._id,
          sessionId: s.sessionId,
          name: s.name,
          phoneNumber: s.phoneNumber,
          status: s.status,
          createdAt: s.createdAt,
        })),
        subscription: subSummary,
      },
    });
  } catch (err) {
    console.error("analytics/dashboard error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/analytics/full?days=7|30  — full analytics page data
router.get("/full", authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const days = Math.min(parseInt(req.query.days) || 7, 90);

    const allSessions = await WhatsAppSession.find({ userId }).lean();
    const sessionIds = allSessions.map(s => s._id);
    const since = daysAgo(days - 1);

    // Daily message breakdown
    const dailyMsgs = await Message.aggregate([
      { $match: { sessionId: { $in: sessionIds }, createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          messages: { $sum: 1 },
          sent: { $sum: { $cond: [{ $in: ["$status", ["sent", "delivered", "read"]] }, 1, 0] } },
          delivered: { $sum: { $cond: [{ $in: ["$status", ["delivered", "read"]] }, 1, 0] } },
          failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const dailyChart = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const found = dailyMsgs.find(m => m._id === key);
      dailyChart.push({
        name: days <= 7 ? dayNames[d.getDay()] : key.slice(5),
        date: key,
        messages: found?.messages || 0,
        sent: found?.sent || 0,
        delivered: found?.delivered || 0,
        failed: found?.failed || 0,
      });
    }

    // Totals in range
    const [total, sent, delivered, failed, pending] = await Promise.all([
      Message.countDocuments({ sessionId: { $in: sessionIds }, createdAt: { $gte: since } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, createdAt: { $gte: since }, status: { $in: ["sent", "delivered", "read"] } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, createdAt: { $gte: since }, status: { $in: ["delivered", "read"] } }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, createdAt: { $gte: since }, status: "failed" }),
      Message.countDocuments({ sessionId: { $in: sessionIds }, createdAt: { $gte: since }, status: "pending" }),
    ]);

    // Hourly distribution (all time or in range)
    const hourlyAgg = await Message.aggregate([
      { $match: { sessionId: { $in: sessionIds }, createdAt: { $gte: since } } },
      { $group: { _id: { $hour: "$createdAt" }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const hourlyData = Array.from({ length: 24 }, (_, h) => {
      const found = hourlyAgg.find(a => a._id === h);
      return found?.count || 0;
    });

    // Campaign type breakdown
    const campaignTypes = await Campaign.aggregate([
      { $match: { userId: new mongoose.Types.ObjectId(userId) } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]);

    // Delivery status breakdown
    const deliveryData = [
      { label: "Delivered", value: delivered, color: "#22c55e" },
      { label: "Sent", value: sent - delivered, color: "#3b82f6" },
      { label: "Failed", value: failed, color: "#ef4444" },
      { label: "Pending", value: pending, color: "#f59e0b" },
    ].filter(d => d.value > 0);

    const totalInRange = total || 1;
    deliveryData.forEach(d => {
      d.pct = Math.round((d.value / totalInRange) * 1000) / 10;
    });

    // API key usage (approximated by messages sent via API key — messageType: single)
    const apiMsgs = await Message.aggregate([
      { $match: { sessionId: { $in: sessionIds }, messageType: "single", createdAt: { $gte: since } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, requests: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);
    const apiChart = dailyChart.map(d => ({
      name: d.name,
      date: d.date,
      requests: apiMsgs.find(a => a._id === d.date)?.requests || 0,
    }));

    // Subscription + plan
    const subSummary = await SubscriptionService.getUsageSummary(userId);

    res.json({
      success: true,
      data: {
        range: { days, since },
        stats: { total, sent, delivered, failed, pending, deliveryRate: sent > 0 ? Math.round((delivered / sent) * 1000) / 10 : 0 },
        dailyChart,
        hourlyData,
        deliveryData,
        campaignTypes,
        apiChart,
        subscription: subSummary,
        sessions: allSessions.map(s => ({
          sessionId: s.sessionId, name: s.name, status: s.status,
        })),
      },
    });
  } catch (err) {
    console.error("analytics/full error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
