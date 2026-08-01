import GoogleReviewSession from "../models/GoogleReviewSession.js";
import GoogleReview from "../models/GoogleReview.js";
import GoogleOAuthSettings from "../../models/GoogleOAuthSettings.js";
import UserGoogleConnection from "../../models/UserGoogleConnection.js";
import axios from "axios";
import jwt from "jsonwebtoken";

const GOOGLE_PLACES_API_BASE = "https://maps.googleapis.com/maps/api/place";
const GOOGLE_OAUTH_AUTHORIZE_URL =
  "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_OAUTH_PROFILE_URL =
  "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_ACCOUNT_MANAGEMENT_API =
  "https://mybusinessaccountmanagement.googleapis.com/v1";
const GOOGLE_BUSINESS_INFO_API =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key";
const FRONTEND_ORIGIN = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/$/, "");
const BACKEND_ORIGIN = (
  process.env.BACKEND_URL ||
  process.env.API_ORIGIN ||
  "http://localhost:3000"
).replace(/\/$/, "");

const isAxiosStatus = (error, status) =>
  Boolean(error?.response?.status) && Number(error.response.status) === status;

const getRateLimitedBusinessProfile = () => ({
  hasAccounts: false,
  hasBusinessProfile: false,
  hasVerifiedLocation: false,
  accountCount: 0,
  locationCount: 0,
  verifiedLocationCount: 0,
  accounts: [],
  selectedLocation: null,
  rateLimited: true,
  message:
    "Google Business API temporarily rate-limited (429). Login successful hai, profile check thodi der baad retry hoga.",
});

class GoogleReviewService {
  async getOAuthSettings() {
    const settings = await GoogleOAuthSettings.findOne({ key: "global" })
      .select("+clientSecret")
      .lean();

    const clientId =
      process.env.GOOGLE_OAUTH_CLIENT_ID || settings?.clientId || "";
    const clientSecret =
      process.env.GOOGLE_OAUTH_CLIENT_SECRET || settings?.clientSecret || "";
    const enabled = settings?.enabled !== false;

    return { clientId, clientSecret, enabled };
  }

  buildRedirectUri() {
    return (
      process.env.GOOGLE_OAUTH_REDIRECT_URI ||
      `${BACKEND_ORIGIN}/api/google-review/oauth/callback`
    ).replace(/\/$/, "");
  }

  createOAuthState(userId, returnTo = "/google-review/connect") {
    return jwt.sign(
      { userId: String(userId), returnTo, flow: "google-review-oauth" },
      JWT_SECRET,
      { expiresIn: "10m" },
    );
  }

  parseOAuthState(state) {
    const decoded = jwt.verify(state, JWT_SECRET);
    if (!decoded || decoded.flow !== "google-review-oauth") {
      throw new Error("Invalid OAuth state");
    }
    return decoded;
  }

  async exchangeCodeForTokens(code) {
    const { clientId, clientSecret, enabled } = await this.getOAuthSettings();

    if (!enabled) {
      throw new Error("Google OAuth is disabled");
    }

    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth client credentials are not configured");
    }

    const redirectUri = this.buildRedirectUri();
    const payload = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    });

    const { data } = await axios.post(
      GOOGLE_OAUTH_TOKEN_URL,
      payload.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    return data;
  }

  async refreshAccessToken(refreshToken) {
    const { clientId, clientSecret } = await this.getOAuthSettings();

    if (!clientId || !clientSecret) {
      throw new Error("Google OAuth client credentials are not configured");
    }

    const payload = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const { data } = await axios.post(
      GOOGLE_OAUTH_TOKEN_URL,
      payload.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );

    return data;
  }

  async fetchGoogleProfile(accessToken) {
    const { data } = await axios.get(GOOGLE_OAUTH_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    return data;
  }

  async fetchBusinessAccounts(accessToken) {
    const { data } = await axios.get(
      `${GOOGLE_ACCOUNT_MANAGEMENT_API}/accounts`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    return data?.accounts || [];
  }

  async fetchBusinessLocations(accessToken, accountName) {
    const { data } = await axios.get(
      `${GOOGLE_BUSINESS_INFO_API}/${accountName}/locations`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        params: {
          readMask: "name,title,locationState,storeCode",
          pageSize: 100,
        },
      },
    );

    return data?.locations || [];
  }

  async checkBusinessProfileRegistration(accessToken) {
    try {
      const accounts = await this.fetchBusinessAccounts(accessToken);

      if (!accounts.length) {
        return {
          hasAccounts: false,
          hasBusinessProfile: false,
          hasVerifiedLocation: false,
          accountCount: 0,
          locationCount: 0,
          verifiedLocationCount: 0,
          accounts: [],
          message:
            "Humein aapke account se juda koi Google Business Profile nahi mila. Kya aap ek naya profile create karna chahte hain?",
        };
      }

      const accountSummaries = [];
      const allLocations = [];
      let rateLimitedCount = 0;

      for (const account of accounts) {
        const accountName = account.name || account.accountName || "";
        if (!accountName) continue;

        try {
          const locations = await this.fetchBusinessLocations(
            accessToken,
            accountName,
          );
          const normalizedLocations = locations.map((location) => ({
            name: location.name || "",
            title: location.title || "",
            storeCode: location.storeCode || "",
            locationState: location.locationState || {},
            isVerified: Boolean(location.locationState?.isVerified),
          }));

          allLocations.push(
            ...normalizedLocations.map((location) => ({
              ...location,
              accountName,
            })),
          );

          accountSummaries.push({
            accountName,
            displayName:
              account.accountName ||
              account.name ||
              account.title ||
              accountName,
            locationCount: normalizedLocations.length,
            verifiedLocationCount: normalizedLocations.filter(
              (location) => location.isVerified,
            ).length,
            locations: normalizedLocations,
          });
        } catch (err) {
          if (isAxiosStatus(err, 429)) {
            rateLimitedCount += 1;
          }

          accountSummaries.push({
            accountName,
            displayName:
              account.accountName ||
              account.name ||
              account.title ||
              accountName,
            locationCount: 0,
            verifiedLocationCount: 0,
            locations: [],
            error: err.message,
          });
        }
      }

      if (rateLimitedCount > 0 && allLocations.length === 0) {
        return {
          ...getRateLimitedBusinessProfile(),
          hasAccounts: true,
          accountCount: accounts.length,
          accounts: accountSummaries,
        };
      }

      const verifiedLocations = allLocations.filter(
        (location) => location.isVerified,
      );
      const selectedLocation = verifiedLocations[0] || allLocations[0] || null;
      const hasUnverifiedProfile =
        allLocations.length > 0 && verifiedLocations.length === 0;

      return {
        hasAccounts: true,
        hasBusinessProfile: allLocations.length > 0,
        hasUnverifiedProfile: hasUnverifiedProfile,
        hasVerifiedLocation: verifiedLocations.length > 0,
        accountCount: accounts.length,
        locationCount: allLocations.length,
        verifiedLocationCount: verifiedLocations.length,
        accounts: accountSummaries,
        selectedLocation,
        rateLimited: rateLimitedCount > 0,
        message:
          verifiedLocations.length > 0
            ? "Google Business Profile verified successfully"
            : allLocations.length > 0
              ? "Google Business Profile found, but the location is not verified yet. You can still use it for testing."
              : "Humein aapke account se juda koi Google Business Profile nahi mila. Kya aap ek naya profile create karna chahte hain?",
      };
    } catch (err) {
      if (isAxiosStatus(err, 429)) {
        return getRateLimitedBusinessProfile();
      }

      console.error("[GR BUSINESS PROFILE CHECK]", err.message);
      return {
        hasAccounts: false,
        hasBusinessProfile: false,
        hasVerifiedLocation: false,
        accountCount: 0,
        locationCount: 0,
        verifiedLocationCount: 0,
        accounts: [],
        selectedLocation: null,
        message:
          "Business profile check abhi complete nahi ho paya. Please thodi der baad retry karein.",
      };
    }
  }

  async upsertReviewSessionFromBusinessProfile(
    userId,
    tokenPayload,
    profile,
    businessProfile,
  ) {
    if (
      !businessProfile?.hasVerifiedLocation ||
      !businessProfile.selectedLocation
    ) {
      return null;
    }

    const selectedLocation = businessProfile.selectedLocation;
    const sessionPayload = {
      userId,
      businessName:
        selectedLocation.title ||
        profile?.name ||
        profile?.email ||
        "Google Business",
      businessId: selectedLocation.name || selectedLocation.storeCode || "",
      googlePlacesId: selectedLocation.name || selectedLocation.storeCode || "",
      googleAccountName: selectedLocation.accountName || "",
      googleLocationName: selectedLocation.name || "",
      googleLocationTitle: selectedLocation.title || "",
      googleLocationStoreCode: selectedLocation.storeCode || "",
      locationState: selectedLocation.locationState || {},
      isLocationVerified: true,
      businessProfileStatus: "verified",
      businessProfileMessage: businessProfile.message || "",
      businessProfileCheckedAt: new Date(),
      accessToken: tokenPayload.access_token || "",
      refreshToken: tokenPayload.refresh_token || "",
      tokenExpiresAt: tokenPayload.expires_in
        ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000)
        : null,
      connectionStatus: "connected",
      connectionError: null,
      isActive: true,
      lastSyncedAt: new Date(),
    };

    const session = await GoogleReviewSession.findOneAndUpdate(
      {
        userId,
        googleLocationName: sessionPayload.googleLocationName,
      },
      { $set: sessionPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return session;
  }

  async upsertReviewSessionFromUnverifiedProfile(
    userId,
    tokenPayload,
    profile,
    businessProfile,
  ) {
    if (
      !businessProfile?.hasUnverifiedProfile ||
      !businessProfile.selectedLocation
    ) {
      return null;
    }

    const selectedLocation = businessProfile.selectedLocation;
    const sessionPayload = {
      userId,
      businessName:
        selectedLocation.title ||
        profile?.name ||
        profile?.email ||
        "Google Business (Testing)",
      businessId: selectedLocation.name || selectedLocation.storeCode || "",
      googlePlacesId: selectedLocation.name || selectedLocation.storeCode || "",
      googleAccountName: selectedLocation.accountName || "",
      googleLocationName: selectedLocation.name || "",
      googleLocationTitle: selectedLocation.title || "",
      googleLocationStoreCode: selectedLocation.storeCode || "",
      locationState: selectedLocation.locationState || {},
      isLocationVerified: false,
      businessProfileStatus: "unverified_testing",
      businessProfileMessage: businessProfile.message || "",
      businessProfileCheckedAt: new Date(),
      accessToken: tokenPayload.access_token || "",
      refreshToken: tokenPayload.refresh_token || "",
      tokenExpiresAt: tokenPayload.expires_in
        ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000)
        : null,
      connectionStatus: "connected_testing",
      connectionError: null,
      isActive: true,
      lastSyncedAt: new Date(),
    };

    const session = await GoogleReviewSession.findOneAndUpdate(
      {
        userId,
        googleLocationName: sessionPayload.googleLocationName,
      },
      { $set: sessionPayload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    return session;
  }

  async resolveAuthorizedConnection(userId) {
    const connection = await this.getStoredUserConnection(userId);

    if (!connection || !connection.accessToken) {
      return { connected: false };
    }

    const expired = connection.expiresAt
      ? new Date(connection.expiresAt) <= new Date()
      : false;

    if (!expired) {
      return {
        connected: true,
        expired: false,
        accessToken: connection.accessToken,
        connection,
      };
    }

    if (!connection.refreshToken) {
      return {
        connected: true,
        expired: true,
        accessToken: connection.accessToken,
        connection,
      };
    }

    try {
      const refreshed = await this.refreshAccessToken(connection.refreshToken);
      const updated = await this.saveOAuthConnection(
        userId,
        refreshed,
        connection,
      );

      return {
        connected: true,
        expired: false,
        refreshed: true,
        accessToken: updated.accessToken,
        connection: updated,
      };
    } catch (err) {
      console.warn("[GR SERVICE REFRESH]", err.message);
      return {
        connected: true,
        expired: true,
        refreshFailed: true,
        accessToken: connection.accessToken,
        connection,
      };
    }
  }

  async getStoredUserConnection(userId) {
    return UserGoogleConnection.findOne({ userId })
      .select("+accessToken +refreshToken")
      .lean();
  }

  async saveOAuthConnection(userId, tokenPayload, profile = {}) {
    const currentConnection = await UserGoogleConnection.findOne({ userId })
      .select("+refreshToken")
      .lean();

    const expiresAt = tokenPayload.expires_in
      ? new Date(Date.now() + Number(tokenPayload.expires_in) * 1000)
      : null;

    await UserGoogleConnection.findOneAndUpdate(
      { userId },
      {
        $set: {
          accessToken: tokenPayload.access_token || "",
          refreshToken:
            tokenPayload.refresh_token || currentConnection?.refreshToken || "",
          expiresAt,
          email: profile.email || "",
          name: profile.name || "",
          picture: profile.picture || "",
        },
      },
      { upsert: true, new: true },
    );

    return this.getStoredUserConnection(userId);
  }

  async getConnectionStatus(userId) {
    const resolved = await this.resolveAuthorizedConnection(userId);

    if (!resolved.connected) {
      return { connected: false };
    }

    const connection = resolved.connection;
    const businessProfile = await this.checkBusinessProfileRegistration(
      resolved.accessToken,
    );

    return {
      connected: true,
      expired: Boolean(resolved.expired),
      refreshFailed: Boolean(resolved.refreshFailed),
      refreshed: Boolean(resolved.refreshed),
      connection: {
        email: connection.email || "",
        name: connection.name || "",
        picture: connection.picture || "",
        expiresAt: connection.expiresAt,
        connectedAt: connection.updatedAt || connection.createdAt,
      },
      businessProfile,
    };
  }

  async buildOAuthStart(userId, returnTo = "/google-review/connect") {
    const { clientId, enabled } = await this.getOAuthSettings();

    if (!enabled) {
      throw new Error("Google OAuth is disabled");
    }

    if (!clientId) {
      throw new Error("Google OAuth client ID is not configured");
    }

    const state = this.createOAuthState(userId, returnTo);
    const redirectUri = this.buildRedirectUri();

    console.log("[GR OAUTH] start", {
      redirectUri,
      clientIdSuffix: clientId ? clientId.slice(-8) : "missing",
      source: process.env.GOOGLE_OAUTH_REDIRECT_URI ? "env" : "fallback",
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope:
        "openid email profile https://www.googleapis.com/auth/business.manage",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });

    return {
      authUrl: `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`,
      redirectUri,
    };
  }

  async handleOAuthCallback({ code, state }) {
    if (!code) {
      throw new Error("Missing OAuth code");
    }

    const decoded = this.parseOAuthState(state);
    const tokenPayload = await this.exchangeCodeForTokens(code);
    const profile = await this.fetchGoogleProfile(tokenPayload.access_token);
    const connection = await this.saveOAuthConnection(
      decoded.userId,
      tokenPayload,
      profile,
    );
    const businessProfile = await this.checkBusinessProfileRegistration(
      tokenPayload.access_token,
    );

    await this.upsertReviewSessionFromBusinessProfile(
      decoded.userId,
      tokenPayload,
      profile,
      businessProfile,
    );

    return {
      userId: decoded.userId,
      connection,
      businessProfile,
      redirectTo: `${FRONTEND_ORIGIN}${decoded.returnTo || "/google-review/connect"}?oauth=success`,
    };
  }

  async disconnectOAuthConnection(userId) {
    await UserGoogleConnection.deleteOne({ userId });
    return { success: true };
  }

  async validateAndSaveConnection(userId, connectionData) {
    try {
      const validation = await axios.get(
        `${GOOGLE_PLACES_API_BASE}/details/json`,
        {
          params: {
            place_id: connectionData.businessId,
            key: connectionData.accessToken,
            fields:
              "name,rating,reviews,formatted_address,formatted_phone_number,website",
          },
        },
      );

      if (!validation.data.result) {
        return {
          success: false,
          error: "Invalid business ID or access token",
        };
      }

      const businessData = validation.data.result;

      let session = await GoogleReviewSession.findOne({
        userId,
        businessId: connectionData.businessId,
      });

      if (!session) {
        session = new GoogleReviewSession({
          userId,
          businessId: connectionData.businessId,
          businessName: connectionData.businessName || businessData.name,
          accessToken: connectionData.accessToken,
          refreshToken: connectionData.refreshToken || null,
          businessAddress: businessData.formatted_address,
          businessPhone: businessData.formatted_phone_number,
          businessWebsite: businessData.website,
          averageRating: businessData.rating || 0,
          totalReviews: businessData.reviews?.length || 0,
          totalRatings: businessData.user_ratings_total || 0,
        });
      } else {
        session.accessToken = connectionData.accessToken;
        if (connectionData.refreshToken) {
          session.refreshToken = connectionData.refreshToken;
        }
        session.businessAddress = businessData.formatted_address;
        session.businessPhone = businessData.formatted_phone_number;
        session.businessWebsite = businessData.website;
        session.averageRating = businessData.rating || 0;
        session.totalReviews = businessData.reviews?.length || 0;
        session.totalRatings = businessData.user_ratings_total || 0;
      }

      session.connectionStatus = "connected";
      session.connectionError = null;
      session.lastSyncedAt = new Date();

      await session.save();

      return { success: true, session };
    } catch (err) {
      console.error("[GR SERVICE VALIDATE]", err.message);
      return {
        success: false,
        error: err.message || "Failed to validate connection",
      };
    }
  }

  async syncReviews(session) {
    try {
      const response = await axios.get(
        `${GOOGLE_PLACES_API_BASE}/details/json`,
        {
          params: {
            place_id: session.businessId,
            key: session.accessToken,
            fields: "reviews,rating,user_ratings_total",
          },
        },
      );

      if (!response.data.result) {
        return { success: false, error: "Failed to fetch reviews" };
      }

      const businessData = response.data.result;
      const reviews = businessData.reviews || [];

      let newReviewsCount = 0;

      for (const review of reviews) {
        const existingReview = await GoogleReview.findOne({
          sessionId: session._id,
          googleReviewId: review.time,
        });

        if (!existingReview) {
          const sentiment = this.analyzeSentiment(review.text || "");

          await GoogleReview.create({
            userId: session.userId,
            sessionId: session._id,
            googleReviewId: review.time.toString(),
            authorName: review.author_name,
            authorPhoto: review.profile_photo_url,
            rating: review.rating,
            reviewText: review.text || "",
            reviewDate: new Date(review.time * 1000),
            updateDate: new Date(review.time * 1000),
            sentiment,
            status: "new",
          });

          newReviewsCount++;
        }
      }

      session.averageRating = businessData.rating || 0;
      session.totalRatings = businessData.user_ratings_total || 0;
      session.lastSyncedAt = new Date();
      session.connectionStatus = "connected";

      await session.save();

      return {
        success: true,
        newReviews: newReviewsCount,
        session,
      };
    } catch (err) {
      console.error("[GR SERVICE SYNC]", err.message);

      session.connectionStatus = "error";
      session.connectionError = err.message;
      await session.save();

      return {
        success: false,
        error: err.message || "Failed to sync reviews",
      };
    }
  }

  analyzeSentiment(text) {
    if (!text) return "neutral";

    const positiveWords = [
      "excellent",
      "amazing",
      "great",
      "wonderful",
      "fantastic",
      "best",
      "love",
      "perfect",
      "awesome",
      "brilliant",
    ];
    const negativeWords = [
      "terrible",
      "awful",
      "bad",
      "worst",
      "horrible",
      "poor",
      "hate",
      "disappointing",
      "waste",
      "useless",
    ];

    const lowerText = text.toLowerCase();

    const positiveMatches = positiveWords.filter((word) =>
      lowerText.includes(word),
    ).length;
    const negativeMatches = negativeWords.filter((word) =>
      lowerText.includes(word),
    ).length;

    if (positiveMatches > negativeMatches) return "positive";
    if (negativeMatches > positiveMatches) return "negative";

    return "neutral";
  }

  async getBusinessMetrics(session) {
    try {
      const totalReviews = await GoogleReview.countDocuments({
        sessionId: session._id,
      });

      const ratingBreakdown = await GoogleReview.aggregate([
        { $match: { sessionId: session._id } },
        { $group: { _id: "$rating", count: { $sum: 1 } } },
      ]);

      return {
        totalReviews,
        averageRating: session.averageRating,
        ratingBreakdown,
      };
    } catch (err) {
      console.error("[GR SERVICE METRICS]", err.message);
      return null;
    }
  }
}

export default new GoogleReviewService();
