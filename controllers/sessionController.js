import { WhatsAppSession } from "../models/index.js";
import WhatsAppService from "../services/WhatsAppService.js";
import mongoose from "mongoose";
import SubscriptionService from "../services/SubscriptionService.js";
import { sendSubscriptionError } from "../utils/subscription.js";

export const createSession = async (req, res) => {
  try {
    const { name, enableChatView = false, chatPasscode = "" } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Session name is required" });
    }

    if (enableChatView && String(chatPasscode).length < 4) {
      return res
        .status(400)
        .json({ error: "Chat passcode must be at least 4 characters" });
    }

    await SubscriptionService.assertResourceLimit(req.user, "sessions", 1);

    console.log("Creating session for user:", req.user?._id, "name:", name);
    const result = await WhatsAppService.createSession(req.user._id, name, {
      enableChatView: !!enableChatView,
      chatPasscode: String(chatPasscode || ""),
    });

    res.status(201).json(result);
  } catch (err) {
    console.error("Create session error:", err);
    return sendSubscriptionError(res, err, "Failed to create session");
  }
};

export const listSessions = async (req, res) => {
  try {
    const sessions = await WhatsAppSession.find({ userId: req.user._id })
      .select("-credentials")
      .sort({ createdAt: -1 });

    const sessionsWithStatus = sessions.map((session) => {
      const liveSession = WhatsAppService.getLiveSessionSnapshot(session);

      return {
        _id: session._id,
        sessionId: session.sessionId,
        name: session.name,
        status: liveSession?.status || session.status,
        phone: liveSession?.phoneNumber || session.phoneNumber,
        phoneNumber: liveSession?.phoneNumber || session.phoneNumber,
        chatViewEnabled: !!session.chatViewEnabled,
        lastConnected: liveSession?.lastConnected || session.lastConnected,
        createdAt: session.createdAt,
      };
    });

    res.json({ success: true, data: sessionsWithStatus });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

export const getSession = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    }).select("-credentials");

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const liveSession = WhatsAppService.getLiveSessionSnapshot(session);

    res.json({
      sessionId: session.sessionId,
      name: session.name,
      status: liveSession?.status || session.status,
      phoneNumber: liveSession?.phoneNumber || session.phoneNumber,
      chatViewEnabled: !!session.chatViewEnabled,
      lastConnected: liveSession?.lastConnected || session.lastConnected,
      createdAt: session.createdAt,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const deleteSession = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await WhatsAppService.deleteSession(id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getSessionQR = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    // Try to get QR code immediately
    let qrCode = WhatsAppService.getPendingQR(id);

    // If QR code is not immediately available, wait for it (max 5 seconds)
    // This handles the race condition where QR generation is async
    if (!qrCode) {
      const maxWaitTime = 5000; // 5 seconds max
      const checkInterval = 100; // Check every 100ms
      let waited = 0;

      while (!qrCode && waited < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, checkInterval));
        waited += checkInterval;
        qrCode = WhatsAppService.getPendingQR(id);
      }
    }

    if (!qrCode) {
      return res.status(404).json({ error: "QR code not available" });
    }

    res.json({ qr: qrCode, sessionId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const reconnectSession = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const result = await WhatsAppService.reconnectSession(id);

    res.json({ success: true, status: result?.status || "connecting" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getPairingCode = async (req, res) => {
  try {
    const { id } = req.params;
    let { phoneNumber } = req.body;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    if (!phoneNumber) {
      return res.status(400).json({ error: "Phone number is required" });
    }

    // Clean phone number: remove '+' and any non-digit characters
    phoneNumber = String(phoneNumber).replace(/\D/g, "");

    const code = await WhatsAppService.requestPairingCode(id, phoneNumber);
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const logoutSession = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    await WhatsAppService.logoutSession(id);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getSessionGroups = async (req, res) => {
  try {
    const { id } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const groups = await WhatsAppService.getGroups(id);
    res.json({ success: true, data: groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getGroupMetadata = async (req, res) => {
  try {
    const { id, groupId } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const metadata = await WhatsAppService.getGroupMetadata(id, groupId);
    res.json({ success: true, data: metadata });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const getGroupInviteLink = async (req, res) => {
  try {
    const { id, groupId } = req.params;

    const session = await WhatsAppSession.findOne({
      sessionId: id,
      userId: req.user._id,
    });

    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const link = await WhatsAppService.getGroupInviteLink(id, groupId);
    res.json({ success: true, link });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default {
  createSession,
  listSessions,
  getSession,
  getSessionQR,
  deleteSession,
  logoutSession,
  reconnectSession,
  getPairingCode,
  getSessionGroups,
  getGroupMetadata,
  getGroupInviteLink,
};

