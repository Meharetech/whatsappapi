import instagramService from "../services/InstagramService.js";
import InstagramDMMessage from "../models/InstagramDMMessage.js";

// Legacy connect (username/password) - now disabled
const connect = async (req, res) => {
  try {
    const state = instagramService.createOAuthState(req.user._id);

    return res.status(400).json({
      error:
        "Legacy Instagram login is no longer supported. Please use OAuth flow.",
      oauth_url: instagramService.getOAuthUrl(state),
    });
  } catch (err) {
    console.error("[IG CONNECT]", err.message);
    return res
      .status(500)
      .json({ error: "internal_error", detail: err.message });
  }
};

// Legacy challenge submission - disabled
const submitChallenge = async (req, res) => {
  try {
    return res.status(400).json({
      error:
        "Legacy challenge flow is no longer supported. Please use OAuth flow.",
    });
  } catch (err) {
    console.error("[IG CHALLENGE]", err.message);
    return res
      .status(500)
      .json({ error: "internal_error", detail: err.message });
  }
};

const sessionStatus = async (req, res) => {
  try {
    const status = await instagramService.checkSessionStatus(req.user._id);
    return res.json(status);
  } catch (err) {
    console.error("[IG STATUS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const remove = async (req, res) => {
  try {
    await instagramService.removeSession(req.user._id);
    return res.json({ success: true });
  } catch (err) {
    console.error("[IG REMOVE]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// New OAuth endpoints
const initiateOAuth = async (req, res) => {
  try {
    const returnTo = req.query.returnTo || "/instagram/connect";
    const manualInstagramBusinessAccountId =
      req.query.instagramBusinessAccountId ||
      req.query.manualInstagramBusinessAccountId ||
      null;
    const state = instagramService.createOAuthState(
      req.user._id,
      returnTo,
      manualInstagramBusinessAccountId,
    );
    const oauthUrl = instagramService.getOAuthUrl(state);
    return res.json({ oauth_url: oauthUrl });
  } catch (err) {
    console.error("[IG OAUTH INIT]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const oauthCallback = async (req, res) => {
  try {
    const { code, state, error, error_reason, error_description } = req.query;
    let oauthState = null;

    if (state) {
      try {
        oauthState = instagramService.parseOAuthState(state);
      } catch (parseError) {
        const redirectTo = instagramService.buildConnectRedirect(
          "/instagram/connect",
          {
            oauth_error: parseError.message || "Invalid OAuth state",
          },
        );
        return res.redirect(redirectTo);
      }
    }

    const returnTo = oauthState?.returnTo || "/instagram/connect";

    if (error) {
      return res.redirect(
        instagramService.buildConnectRedirect(returnTo, {
          oauth_error:
            error_description || error_reason || error || "oauth_failed",
        }),
      );
    }
    if (!code) {
      return res.redirect(
        instagramService.buildConnectRedirect(returnTo, {
          oauth_error: "missing_code",
        }),
      );
    }

    if (!oauthState?.userId) {
      return res.redirect(
        instagramService.buildConnectRedirect(returnTo, {
          oauth_error: "missing_state",
        }),
      );
    }

    const result = await instagramService.handleOAuthCallback(
      oauthState.userId,
      code,
      {
        manualInstagramBusinessAccountId:
          oauthState.manualInstagramBusinessAccountId || null,
      },
    );
    if (result.success) {
      return res.redirect(
        instagramService.buildConnectRedirect(returnTo, {
          oauth_success: "1",
        }),
      );
    }

    return res.redirect(
      instagramService.buildConnectRedirect(returnTo, {
        oauth_error: result.error || "oauth_failed",
      }),
    );
  } catch (err) {
    console.error("[IG OAUTH CALLBACK]", err.message);
    return res.redirect(
      instagramService.buildConnectRedirect("/instagram/connect", {
        oauth_error: err.message || "oauth_failed",
      }),
    );
  }
};

const fetchMedia = async (req, res) => {
  try {
    const { limit, after, type } = req.query;
    const result = await instagramService.fetchMedia(req.user._id, {
      limit: limit ? parseInt(limit) : 25,
      after: after || null,
      type: type || null,
    });
    if (result.success) {
      return res.json({
        success: true,
        data: result.data,
        paging: result.paging,
      });
    } else {
      return res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error("[IG FETCH MEDIA]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const fetchComments = async (req, res) => {
  try {
    const { mediaId } = req.params;
    const { limit } = req.query;
    if (!mediaId) {
      return res.status(400).json({ error: "mediaId required" });
    }
    const result = await instagramService.fetchComments(req.user._id, mediaId, {
      limit: limit ? parseInt(limit) : 100,
    });
    if (result.success) {
      return res.json({ success: true, data: result.data });
    } else {
      return res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error("[IG FETCH COMMENTS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const fetchMediaCounts = async (req, res) => {
  try {
    const result = await instagramService.countMediaByType(req.user._id);
    if (result.success) {
      return res.json({ success: true, counts: result.counts });
    }
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG FETCH MEDIA COUNTS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Debug endpoint to verify token validity
const debugTokenStatus = async (req, res) => {
  try {
    const status = await instagramService.checkSessionStatus(req.user._id);

    if (!status.exists) {
      return res.json({
        success: false,
        message: "No Instagram session found",
      });
    }

    // Verify the stored token is still valid
    if (status.graph?.facebookUserAccessToken) {
      const tokenValid = await instagramService.verifyAccessToken(
        status.graph.facebookUserAccessToken,
      );
      return res.json({
        success: true,
        session: {
          username: status.username,
          status: status.status,
          igAccountId: status.graph?.instagramBusinessAccountId,
          discoveryMode: status.graph?.discoveryMode,
          manualInstagramBusinessAccountId:
            status.graph?.manualInstagramBusinessAccountId,
          pageId: status.graph?.facebookPageId,
          followers: status.graph?.instagramFollowersCount,
        },
        tokenStatus: tokenValid,
        scopes: status.graph?.scopes,
        lastRefreshed: status.graph?.lastRefreshed,
      });
    }

    return res.json({ success: true, session: status });
  } catch (err) {
    console.error("[IG DEBUG TOKEN]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// DM endpoints
const fetchConversations = async (req, res) => {
  try {
    const { folder, limit, after } = req.query;
    const result = await instagramService.fetchConversations(req.user._id, {
      folder: folder || "inbox",
      limit: limit ? parseInt(limit) : 25,
      after: after || null,
    });
    if (result.success)
      return res.json({
        success: true,
        data: result.data,
        paging: result.paging,
      });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG FETCH CONVERSATIONS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const fetchConversationMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { limit, after } = req.query;
    const result = await instagramService.fetchConversationMessages(
      req.user._id,
      conversationId,
      {
        limit: limit ? parseInt(limit) : 25,
        after: after || null,
      },
    );
    if (result.success)
      return res.json({
        success: true,
        data: result.data,
        paging: result.paging,
      });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG FETCH CONVERSATION MESSAGES]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const sendDirectMessage = async (req, res) => {
  try {
    const { recipientId, message } = req.body;
    if (!recipientId || !message)
      return res
        .status(400)
        .json({ error: "recipientId and message required" });
    const result = await instagramService.sendDirectMessage(req.user._id, {
      recipientId,
      message,
    });
    if (result.success) return res.json({ success: true, data: result.data });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG SEND DIRECT MESSAGE]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const approveRequest = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const result = await instagramService.updateMessageRequest(
      req.user._id,
      conversationId,
      "approve",
    );
    if (result.success) return res.json({ success: true, data: result.data });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG APPROVE REQUEST]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const declineRequest = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const result = await instagramService.updateMessageRequest(
      req.user._id,
      conversationId,
      "decline",
    );
    if (result.success) return res.json({ success: true, data: result.data });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG DECLINE REQUEST]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// Stored (DB) fallback for Instagram DMs
const fetchStoredConversations = async (req, res) => {
  try {
    // Group by conversationId, return latest message per conversation
    const docs = await InstagramDMMessage.aggregate([
      { $match: { userId: null } },
      { $sort: { receivedAt: -1 } },
      {
        $group: {
          _id: "$conversationId",
          lastMessage: { $first: "$text" },
          fromId: { $first: "$fromId" },
          toId: { $first: "$toId" },
          messageId: { $first: "$messageId" },
          receivedAt: { $first: "$receivedAt" },
        },
      },
      { $sort: { receivedAt: -1 } },
      { $limit: 200 },
    ]).exec();

    return res.json({
      success: true,
      data: docs.map((d) => ({
        conversationId: d._id,
        lastMessage: d.lastMessage,
        fromId: d.fromId,
        toId: d.toId,
        messageId: d.messageId,
        receivedAt: d.receivedAt,
      })),
    });
  } catch (err) {
    console.error("[IG FETCH STORED CONVERSATIONS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const fetchStoredConversationMessages = async (req, res) => {
  try {
    const { conversationId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit) : 100;
    if (!conversationId)
      return res.status(400).json({ error: "conversationId required" });

    const msgs = await InstagramDMMessage.find({ conversationId })
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean();
    return res.json({
      success: true,
      data: msgs.map((m) => ({
        id: m._id,
        messageId: m.messageId,
        fromId: m.fromId,
        toId: m.toId,
        text: m.text,
        receivedAt: m.receivedAt,
      })),
    });
  } catch (err) {
    console.error("[IG FETCH STORED MESSAGES]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

const fetchNotifications = async (req, res) => {
  try {
    const { limit, type } = req.query;
    const result = await instagramService.fetchNotifications(req.user._id, {
      limit: limit ? parseInt(limit) : 50,
      type: type || "all",
    });
    if (result.success) return res.json({ success: true, data: result.data });
    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[IG FETCH NOTIFICATIONS]", err.message);
    return res.status(500).json({ error: err.message });
  }
};

export default {
  connect,
  submitChallenge,
  sessionStatus,
  remove,
  initiateOAuth,
  oauthCallback,
  fetchMedia,
  fetchComments,
  fetchMediaCounts,
  debugTokenStatus,
  // DMs
  fetchConversations,
  fetchConversationMessages,
  sendDirectMessage,
  approveRequest,
  declineRequest,
  // Stored fallback
  fetchStoredConversations,
  fetchStoredConversationMessages,
  // Notifications
  fetchNotifications,
};
