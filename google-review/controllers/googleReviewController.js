import GoogleReviewSession from "../models/GoogleReviewSession.js";
import GoogleReview from "../models/GoogleReview.js";
import UserGoogleConnection from "../../models/UserGoogleConnection.js";
import googleReviewService from "../services/GoogleReviewService.js";

const getFrontendOrigin = () =>
  (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");

const oauthStart = async (req, res) => {
  try {
    const result = await googleReviewService.buildOAuthStart(req.user._id);

    if (result.alreadyConnected) {
      return res.json({
        success: true,
        alreadyConnected: true,
        connection: result.connection,
        businessProfile: result.businessProfile || null,
      });
    }

    return res.json({
      success: true,
      alreadyConnected: false,
      authUrl: result.authUrl,
    });
  } catch (err) {
    console.error("[GR OAUTH START]", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to start Google OAuth",
    });
  }
};

const oauthCallback = async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.redirect(
        `${getFrontendOrigin()}/google-review/connect?oauth=error&message=${encodeURIComponent(error)}`,
      );
    }

    const result = await googleReviewService.handleOAuthCallback({
      code,
      state,
    });

    return res.redirect(result.redirectTo);
  } catch (err) {
    console.error("[GR OAUTH CALLBACK]", err.message);
    return res.redirect(
      `${getFrontendOrigin()}/google-review/connect?oauth=error&message=${encodeURIComponent(err.message || "OAuth failed")}`,
    );
  }
};

const oauthStatus = async (req, res) => {
  try {
    const status = await googleReviewService.getConnectionStatus(req.user._id);

    return res.json({
      success: true,
      data: status,
    });
  } catch (err) {
    console.error("[GR OAUTH STATUS]", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to read Google OAuth status",
    });
  }
};

const oauthDisconnect = async (req, res) => {
  try {
    await UserGoogleConnection.deleteOne({ userId: req.user._id });

    return res.json({
      success: true,
      message: "Google connection removed",
    });
  } catch (err) {
    console.error("[GR OAUTH DISCONNECT]", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to disconnect Google account",
    });
  }
};

const oauthAcceptUnverified = async (req, res) => {
  try {
    const status = await googleReviewService.getConnectionStatus(req.user._id);

    if (!status.connected || !status.businessProfile?.hasUnverifiedProfile) {
      return res.status(400).json({
        success: false,
        error: "No unverified business profile found to accept",
      });
    }

    const connection = await googleReviewService.getStoredUserConnection(
      req.user._id,
    );

    const profile = {
      email: connection?.email || "",
      name: connection?.name || "",
      picture: connection?.picture || "",
    };

    const tokenPayload = {
      access_token: connection?.accessToken || "",
      refresh_token: connection?.refreshToken || "",
      expires_in: connection?.expiresAt
        ? Math.floor((new Date(connection.expiresAt) - new Date()) / 1000)
        : 3600,
    };

    const session =
      await googleReviewService.upsertReviewSessionFromUnverifiedProfile(
        req.user._id,
        tokenPayload,
        profile,
        status.businessProfile,
      );

    return res.json({
      success: true,
      message: "Unverified profile accepted for testing",
      session,
      businessProfile: status.businessProfile,
    });
  } catch (err) {
    console.error("[GR OAUTH ACCEPT UNVERIFIED]", err.message);
    return res.status(500).json({
      success: false,
      error: err.message || "Failed to accept unverified profile",
    });
  }
};

const connect = async (req, res) => {
  try {
    const { businessId, businessName, accessToken, refreshToken } = req.body;

    if (!businessId || !accessToken) {
      return res.status(400).json({
        error: "businessId and accessToken required",
      });
    }

    const result = await googleReviewService.validateAndSaveConnection(
      req.user._id,
      {
        businessId,
        businessName,
        accessToken,
        refreshToken,
      },
    );

    if (result.success) {
      return res.json({ success: true, session: result.session });
    }

    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[GR CONNECT]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

const getSession = async (req, res) => {
  try {
    const sessions = await GoogleReviewSession.find({
      userId: req.user._id,
    }).select("-accessToken -refreshToken");

    return res.json({
      success: true,
      sessions,
    });
  } catch (err) {
    console.error("[GR GET SESSION]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

const getReviews = async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { status, rating, page = 1, limit = 20 } = req.query;

    const query = {
      userId: req.user._id,
      sessionId,
    };

    if (status) query.status = status;
    if (rating) query.rating = parseInt(rating);

    const skip = (page - 1) * limit;
    const reviews = await GoogleReview.find(query)
      .sort({ reviewDate: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await GoogleReview.countDocuments(query);

    return res.json({
      success: true,
      reviews,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[GR GET REVIEWS]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

const replyToReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { replyText } = req.body;

    if (!replyText) {
      return res.status(400).json({ error: "replyText required" });
    }

    const review = await GoogleReview.findById(reviewId);

    if (!review || review.userId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ error: "Review not found" });
    }

    review.replyText = replyText;
    review.replyDate = new Date();
    review.isReplied = true;
    review.status = "replied";

    await review.save();

    return res.json({ success: true, review });
  } catch (err) {
    console.error("[GR REPLY]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

const syncReviews = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await GoogleReviewSession.findById(sessionId);

    if (!session || session.userId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    const result = await googleReviewService.syncReviews(session);

    if (result.success) {
      return res.json({
        success: true,
        message: `Synced ${result.newReviews} new reviews`,
        session: result.session,
      });
    }

    return res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    console.error("[GR SYNC]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

const getAnalytics = async (req, res) => {
  try {
    const { sessionId } = req.params;

    const session = await GoogleReviewSession.findById(sessionId);

    if (!session || session.userId.toString() !== req.user._id.toString()) {
      return res.status(404).json({ error: "Session not found" });
    }

    const totalReviews = await GoogleReview.countDocuments({
      sessionId,
    });

    const ratingDistribution = await GoogleReview.aggregate([
      { $match: { sessionId: session._id } },
      { $group: { _id: "$rating", count: { $sum: 1 } } },
    ]);

    const sentimentDistribution = await GoogleReview.aggregate([
      { $match: { sessionId: session._id } },
      { $group: { _id: "$sentiment", count: { $sum: 1 } } },
    ]);

    const repliedReviews = await GoogleReview.countDocuments({
      sessionId,
      isReplied: true,
    });

    const averageRating =
      ratingDistribution.length > 0
        ? (
            ratingDistribution.reduce(
              (sum, item) => sum + item._id * item.count,
              0,
            ) / totalReviews
          ).toFixed(2)
        : 0;

    return res.json({
      success: true,
      analytics: {
        totalReviews,
        averageRating: parseFloat(averageRating),
        repliedReviews,
        replyRate:
          totalReviews > 0
            ? ((repliedReviews / totalReviews) * 100).toFixed(1)
            : 0,
        ratingDistribution,
        sentimentDistribution,
      },
    });
  } catch (err) {
    console.error("[GR ANALYTICS]", err.message);
    return res.status(500).json({
      error: "internal_error",
      detail: err.message,
    });
  }
};

export default {
  oauthStart,
  oauthCallback,
  oauthStatus,
  oauthDisconnect,
  oauthAcceptUnverified,
  connect,
  getSession,
  getReviews,
  replyToReview,
  syncReviews,
  getAnalytics,
};
