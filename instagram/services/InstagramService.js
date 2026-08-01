import InstagramSession from "../models/InstagramSession.js";
import axios from "axios";
import jwt from "jsonwebtoken";

const GRAPH_API_VERSION = "v20.0";
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key";
const FRONTEND_ORIGIN = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/$/, "");

function getFacebookAppId() {
  return process.env.FACEBOOK_APP_ID;
}

function getFacebookAppSecret() {
  return process.env.FACEBOOK_APP_SECRET;
}

function getFacebookRedirectUri() {
  const backendOrigin = (
    process.env.BACKEND_URL ||
    process.env.API_ORIGIN ||
    process.env.BASE_URL ||
    "http://localhost:3000"
  ).replace(/\/$/, "");

  return (
    process.env.FACEBOOK_REDIRECT_URI ||
    `${backendOrigin}/api/instagram/oauth/callback`
  );
}

function getFrontendOrigin() {
  return FRONTEND_ORIGIN;
}

// Validation warning
if (!getFacebookAppId() || !getFacebookAppSecret()) {
  console.warn(
    "FACEBOOK_APP_ID or FACEBOOK_APP_SECRET not set. Instagram Graph API will not work.",
  );
}

/**
 * Generate Facebook OAuth URL for Instagram Graph API
 * @param {string} state - optional state parameter for CSRF protection
 * @returns {string} OAuth URL
 */
function getOAuthUrl(state = "") {
  const scopes = [
    "instagram_basic",
    "instagram_manage_comments",
    "instagram_manage_messages", // Essential for SaaS automation
    "instagram_content_publish",
    "pages_read_engagement",
    "pages_show_list",
  ].join(",");

  const params = new URLSearchParams({
    client_id: getFacebookAppId(),
    redirect_uri: getFacebookRedirectUri(),
    scope: scopes,
    state,
    response_type: "code",
    auth_type: "rerequest", // Forces the user to see the permission screen again
    display: "page",
  });

  return `https://www.facebook.com/v20.0/dialog/oauth?${params.toString()}`;
}
function createOAuthState(
  userId,
  returnTo = "/instagram/connect",
  manualInstagramBusinessAccountId = null,
) {
  return jwt.sign(
    {
      userId: String(userId),
      returnTo,
      flow: "instagram-oauth",
      manualInstagramBusinessAccountId: manualInstagramBusinessAccountId
        ? String(manualInstagramBusinessAccountId)
        : null,
    },
    JWT_SECRET,
    { expiresIn: "10m" },
  );
}

function parseOAuthState(state) {
  const decoded = jwt.verify(state, JWT_SECRET);
  if (!decoded || decoded.flow !== "instagram-oauth") {
    throw new Error("Invalid OAuth state");
  }
  return decoded;
}

function buildConnectRedirect(returnTo, query) {
  const path = returnTo || "/instagram/connect";
  const search = new URLSearchParams(query);
  return `${getFrontendOrigin()}${path}?${search.toString()}`;
}

/**
 * Exchange authorization code for short-lived access token
 * @param {string} code
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number}>}
 */
async function exchangeCodeForToken(code) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`;
  const params = {
    client_id: getFacebookAppId(),
    client_secret: getFacebookAppSecret(),
    redirect_uri: getFacebookRedirectUri(),
    code,
  };

  const response = await axios.get(url, { params });
  return response.data;
}

/**
 * Exchange short-lived token for long-lived token (60 days)
 * @param {string} shortLivedToken
 * @returns {Promise<{access_token: string, token_type: string, expires_in: number}>}
 */
async function getLongLivedToken(shortLivedToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/oauth/access_token`;
  const params = {
    grant_type: "fb_exchange_token",
    client_id: getFacebookAppId(),
    client_secret: getFacebookAppSecret(),
    fb_exchange_token: shortLivedToken,
  };

  const response = await axios.get(url, { params });
  return response.data;
}

/**
 * Get user's Facebook pages with access tokens
 * @param {string} userAccessToken
 * @returns {Promise<Array<{id: string, name: string, access_token: string}>>}
 */
async function getUserPages(userAccessToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/accounts`;
  const response = await axios.get(url, {
    params: {
      fields: "name,access_token,instagram_business_account{id,username}",
      access_token: userAccessToken,
    },
  });
  return response.data.data;
}

function resolveGraphAccessToken(sessionGraph) {
  return (
    sessionGraph?.facebookPageAccessToken ||
    sessionGraph?.facebookUserAccessToken ||
    null
  );
}

/**
 * Get Instagram Business Account ID linked to a Facebook Page
 * @param {string} pageId
 * @param {string} pageAccessToken
 * @returns {Promise<string|null>} Instagram Business Account ID or null
 */
async function getInstagramBusinessAccountId(pageId, pageAccessToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${pageId}`;
  try {
    const response = await axios.get(url, {
      params: {
        fields: "instagram_business_account",
        access_token: pageAccessToken,
      },
    });
    return response.data.instagram_business_account?.id || null;
  } catch (error) {
    console.error(
      "Error fetching Instagram Business Account:",
      error.response?.data || error.message,
    );
    return null;
  }
}

/**
 * Get Instagram Business Account details
 * @param {string} instagramBusinessAccountId
 * @param {string} accessToken
 * @returns {Promise<{id: string, username: string, profile_picture_url: string, followers_count: number, media_count: number}>}
 */
async function getInstagramAccountInfo(
  instagramBusinessAccountId,
  accessToken,
) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instagramBusinessAccountId}`;
  const response = await axios.get(url, {
    params: {
      fields: "id,username,profile_picture_url,followers_count,media_count",
      access_token: accessToken,
    },
  });
  return response.data;
}

async function getInstagramAccountInfoSafe(
  instagramBusinessAccountId,
  accessToken,
) {
  try {
    return {
      success: true,
      data: await getInstagramAccountInfo(
        instagramBusinessAccountId,
        accessToken,
      ),
    };
  } catch (error) {
    console.error(
      "[Instagram Account Info Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Handle OAuth callback: exchange code, get tokens, pages, Instagram Business Account, and store session
 * @param {string} userId
 * @param {string} code
 * @returns {Promise<{success: boolean, error?: string, data?: any}>}
 */
async function handleOAuthCallback(userId, code, options = {}) {
  try {
    const manualInstagramBusinessAccountId =
      options.manualInstagramBusinessAccountId || null;

    // 1. Exchange code for short-lived token
    const tokenData = await exchangeCodeForToken(code);
    const shortLivedToken = tokenData.access_token;

    // ... Step 2 exchange logic ...
    const longLivedTokenData = await getLongLivedToken(shortLivedToken);
    const longLivedToken = longLivedTokenData.access_token;

    // Meta kabhi 'expires_in' deta hai, kabhi nahi (agar token non-expiring ho)
    // Default 60 days (5184000 seconds) rakhein agar value na mile
    const expiresIn = longLivedTokenData.expires_in || 5184000;

    // Date calculate karte waqt check karein
    const expirationDate = new Date(Date.now() + Number(expiresIn) * 1000);

    // Check if expirationDate is valid
    const finalExpiry = isNaN(expirationDate.getTime())
      ? new Date(Date.now() + 5184000 * 1000) // Fallback to 60 days
      : expirationDate;

    const tokenCheck = await verifyAccessToken(longLivedToken);
    console.log("[Instagram OAuth Debug] Token check:", {
      valid: tokenCheck.valid,
      userId: tokenCheck.id,
      tokenUserId: tokenData.user_id || null,
      manualInstagramBusinessAccountId,
      scopes: [
        "instagram_basic",
        "instagram_manage_comments",
        "instagram_manage_messages",
        "instagram_content_publish",
        "pages_read_engagement",
        "business_management",
        "pages_show_list",
      ],
    });

    // 3. Get user's pages with linked Instagram account fields
    const pages = await getUserPages(longLivedToken);
    if (!pages || pages.length === 0) {
      console.error("[Instagram OAuth Debug] No Facebook pages returned", {
        userId,
        tokenCheck,
        tokenUserId: tokenData.user_id || null,
        note: "Check Meta App Review > Permissions and Features for Advanced Access, verify the app is Live, and confirm the Page has FULL CONTROL and is linked to Instagram.",
      });

      if (manualInstagramBusinessAccountId) {
        const manualAccount = await getInstagramAccountInfoSafe(
          manualInstagramBusinessAccountId,
          longLivedToken,
        );

        const manualIgAccount = manualAccount.success
          ? manualAccount.data
          : {
              id: manualInstagramBusinessAccountId,
              username: null,
              profile_picture_url: null,
              followers_count: 0,
              media_count: 0,
            };

        await InstagramSession.findOneAndUpdate(
          { userId },
          {
            userId,
            instagram: {
              username: manualIgAccount.username,
              lastLogin: new Date(),
            },
            graph: {
              facebookUserId: tokenData.user_id || null,
              facebookUserAccessToken: longLivedToken,
              facebookUserAccessTokenExpiresAt: finalExpiry,
              facebookPageId: null,
              facebookPageAccessToken: null,
              instagramBusinessAccountId: manualInstagramBusinessAccountId,
              instagramUsername: manualIgAccount.username,
              instagramProfilePictureUrl: manualIgAccount.profile_picture_url,
              instagramFollowersCount: manualIgAccount.followers_count || 0,
              instagramMediaCount: manualIgAccount.media_count || 0,
              manualInstagramBusinessAccountId,
              discoveryMode: "manual",
              scopes: [
                "instagram_basic",
                "instagram_manage_comments",
                "instagram_manage_messages",
                "instagram_content_publish",
                "pages_read_engagement",
                "pages_show_list",
              ],
              lastRefreshed: new Date(),
            },
            status: "oauth_connected",
          },
          { upsert: true, new: true },
        );

        return {
          success: true,
          data: {
            username: manualIgAccount.username,
            profilePicture: manualIgAccount.profile_picture_url,
            followers: manualIgAccount.followers_count,
            media: manualIgAccount.media_count,
            pageId: null,
            instagramBusinessAccountId: manualInstagramBusinessAccountId,
            manualFallback: true,
          },
        };
      }

      return {
        success: false,
        error:
          "No Facebook pages found. Check that the app is Live, the token has Advanced Access for pages_show_list, the user has FULL CONTROL on the Page, and the Page is linked to the Instagram Business account.",
      };
    }

    // Pick the first page that has an Instagram Business Account returned by Graph API
    let instagramBusinessAccountId = null;
    let pageAccessToken = null;
    let pageId = null;

    for (const page of pages) {
      const igId = await getInstagramBusinessAccountId(
        page.id,
        page.access_token,
      );
      if (igId) {
        instagramBusinessAccountId = igId;
        pageAccessToken = page.access_token;
        pageId = page.id;
        break;
      }
    }

    if (!instagramBusinessAccountId) {
      console.error(
        "[Instagram OAuth Debug] Pages returned but no linked Instagram account was discovered",
        {
          userId,
          pageCount: pages.length,
          pageIds: pages.map((page) => page.id),
          note: "Check Page settings > Linked Accounts > Instagram, confirm the Page has FULL CONTROL, and verify Advanced Access on pages_show_list in App Review > Permissions and Features.",
        },
      );

      if (manualInstagramBusinessAccountId) {
        const manualAccount = await getInstagramAccountInfoSafe(
          manualInstagramBusinessAccountId,
          longLivedToken,
        );

        const manualIgAccount = manualAccount.success
          ? manualAccount.data
          : {
              id: manualInstagramBusinessAccountId,
              username: null,
              profile_picture_url: null,
              followers_count: 0,
              media_count: 0,
            };

        await InstagramSession.findOneAndUpdate(
          { userId },
          {
            userId,
            instagram: {
              username: manualIgAccount.username,
              lastLogin: new Date(),
            },
            graph: {
              facebookUserId: tokenData.user_id || null,
              facebookUserAccessToken: longLivedToken,
              facebookUserAccessTokenExpiresAt: finalExpiry,
              facebookPageId: null,
              facebookPageAccessToken: null,
              instagramBusinessAccountId: manualInstagramBusinessAccountId,
              instagramUsername: manualIgAccount.username,
              instagramProfilePictureUrl: manualIgAccount.profile_picture_url,
              instagramFollowersCount: manualIgAccount.followers_count || 0,
              instagramMediaCount: manualIgAccount.media_count || 0,
              manualInstagramBusinessAccountId,
              discoveryMode: "manual",
              scopes: [
                "instagram_basic",
                "instagram_manage_comments",
                "instagram_manage_messages",
                "instagram_content_publish",
                "pages_read_engagement",
                "pages_show_list",
              ],
              lastRefreshed: new Date(),
            },
            status: "oauth_connected",
          },
          { upsert: true, new: true },
        );

        return {
          success: true,
          data: {
            username: manualIgAccount.username,
            profilePicture: manualIgAccount.profile_picture_url,
            followers: manualIgAccount.followers_count,
            media: manualIgAccount.media_count,
            pageId: null,
            instagramBusinessAccountId: manualInstagramBusinessAccountId,
            manualFallback: true,
          },
        };
      }

      return {
        success: false,
        error:
          "No Instagram Business Account linked to any of your Facebook Pages. Check Linked Accounts in the Page settings, App Review > Permissions and Features for Advanced Access, and use the localhost manual fallback if needed.",
      };
    }

    // 4. Get Instagram account info
    const igAccount = await getInstagramAccountInfo(
      instagramBusinessAccountId,
      resolveGraphAccessToken({
        facebookPageAccessToken: pageAccessToken,
        facebookUserAccessToken: longLivedToken,
      }),
    );

    // 5. Store session in database
    const update = {
      userId,
      instagram: {
        username: igAccount.username,
        lastLogin: new Date(),
      },
      graph: {
        facebookUserId: tokenData.user_id || null,
        facebookUserAccessToken: longLivedToken,
        facebookUserAccessTokenExpiresAt: finalExpiry,
        facebookPageId: pageId,
        facebookPageAccessToken: pageAccessToken,
        instagramBusinessAccountId,
        instagramUsername: igAccount.username,
        instagramProfilePictureUrl: igAccount.profile_picture_url,
        instagramFollowersCount: igAccount.followers_count || 0,
        instagramMediaCount: igAccount.media_count || 0,
        discoveryMode: "auto",
        scopes: [
          "instagram_basic",
          "instagram_manage_comments",
          "instagram_manage_messages",
          "instagram_content_publish",
          "pages_read_engagement",
          "pages_show_list",
        ],
        lastRefreshed: new Date(),
      },
      status: "oauth_connected",
    };

    await InstagramSession.findOneAndUpdate({ userId }, update, {
      upsert: true,
      new: true,
    });

    return {
      success: true,
      data: {
        username: igAccount.username,
        profilePicture: igAccount.profile_picture_url,
        followers: igAccount.followers_count,
        media: igAccount.media_count,
        pageId,
        instagramBusinessAccountId,
        manualFallback: false,
      },
    };
  } catch (error) {
    console.error(
      "[Instagram OAuth Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error:
        error.response?.data?.error?.message ||
        error.message ||
        "OAuth flow failed",
    };
  }
}

/**
 * Check if user has a valid Instagram Graph API session
 * @param {string} userId
 * @returns {Promise<{exists: boolean, username?: string, status?: string, lastLogin?: Date, graph?: any}>}
 */
async function checkSessionStatus(userId) {
  const session = await InstagramSession.findOne({ userId });
  if (!session) {
    return { exists: false };
  }

  // If using legacy session, return legacy data
  if (
    session.status === "connected" ||
    session.status === "challenge_required"
  ) {
    return {
      exists: true,
      username: session.instagram?.username,
      status: session.status,
      lastLogin: session.instagram?.lastLogin,
      legacy: true,
    };
  }

  // Graph API session
  return {
    exists: true,
    username: session.graph?.instagramUsername || session.instagram?.username,
    status: session.status,
    lastLogin: session.graph?.lastRefreshed || session.instagram?.lastLogin,
    graph: session.graph,
  };
}

/**
 * Remove Instagram session
 * @param {string} userId
 * @returns {Promise<{success: boolean}>}
 */
async function removeSession(userId) {
  await InstagramSession.deleteOne({ userId });
  return { success: true };
}

/**
 * Fetch media (posts) from Instagram Business Account
 * @param {string} userId
 * @param {object} options
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function fetchMedia(userId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const { instagramBusinessAccountId } = session.graph;
  const baseUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instagramBusinessAccountId}/media`;
  const accessToken = resolveGraphAccessToken(session.graph);
  const limit = options.limit || 25;
  const requestedType = options.type || null; // 'post'|'reel'|'all'
  const afterCursor = options.after || null;

  // helper to map requested type to Graph media_type values
  const matchesType = (media, reqType) => {
    if (!reqType || reqType === "all") return true;
    const mt = (media.media_type || "").toUpperCase();
    if (reqType === "reel") return mt === "VIDEO" || mt === "REEL";
    if (reqType === "post") return mt === "IMAGE" || mt === "CAROUSEL_ALBUM";
    return true;
  };

  try {
    // We'll collect pages until we have `limit` items matching the requested type
    let url = baseUrl;
    let params = {
      fields:
        "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count",
      access_token: accessToken,
      limit,
    };
    if (afterCursor) params.after = afterCursor;

    let collected = [];
    let lastPaging = null;
    let firstResponse = true;

    while (true) {
      const response = await axios.get(url, { params });
      const data = response.data.data || [];
      const paging = response.data.paging || null;

      // filter by requestedType if provided
      const filtered = requestedType
        ? data.filter((m) => matchesType(m, requestedType))
        : data;

      collected = collected.concat(filtered);
      lastPaging = paging;

      // if this is the first response and requestedType is null, we can break early
      if (!requestedType) break;

      // stop when we have enough
      if (collected.length >= limit) break;

      // if there's more pages, follow next cursor; otherwise stop
      const nextAfter = paging?.cursors?.after ?? null;
      if (!nextAfter) break;

      // prepare next request - use the same base url with new after
      params = {
        ...params,
        after: nextAfter,
      };
      // continue looping to fetch next page
      firstResponse = false;
    }

    // Trim to requested limit
    const finalData = collected.slice(0, limit);
    return { success: true, data: finalData, paging: lastPaging };
  } catch (error) {
    console.error(
      "[Instagram Fetch Media Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Count media types (total, posts, reels) by paging through media edge.
 * NOTE: This will iterate pages until exhausted. Use with caution for very large accounts.
 */
async function countMediaByType(userId) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const { instagramBusinessAccountId } = session.graph;
  const baseUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instagramBusinessAccountId}/media`;
  const accessToken = resolveGraphAccessToken(session.graph);

  try {
    let counts = { total: 0, posts: 0, reels: 0 };
    let params = {
      fields: "id,media_type",
      access_token: accessToken,
      limit: 50,
    };
    let nextAfter = null;

    while (true) {
      if (nextAfter) params.after = nextAfter;
      const response = await axios.get(baseUrl, { params });
      const data = response.data.data || [];
      const paging = response.data.paging || null;

      for (const m of data) {
        counts.total += 1;
        const mt = (m.media_type || "").toUpperCase();
        if (mt === "VIDEO" || mt === "REEL") counts.reels += 1;
        else if (mt === "IMAGE" || mt === "CAROUSEL_ALBUM") counts.posts += 1;
        else counts.posts += 1;
      }

      nextAfter = paging?.cursors?.after ?? null;
      if (!nextAfter) break;
    }

    return { success: true, counts };
  } catch (error) {
    console.error(
      "[Instagram Count Media Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Fetch comments for a specific media
 * @param {string} userId
 * @param {string} mediaId
 * @param {object} options
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function fetchComments(userId, mediaId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (!session || !resolveGraphAccessToken(session.graph)) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}/comments`;
  const params = {
    fields: "id,text,username,timestamp,like_count",
    access_token: resolveGraphAccessToken(session.graph),
    limit: options.limit || 100,
  };

  try {
    const response = await axios.get(url, { params });
    return { success: true, data: response.data.data };
  } catch (error) {
    console.error(
      "[Instagram Fetch Comments Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Verify user's token is valid by checking /me endpoint
 * @param {string} accessToken - Facebook user access token
 * @returns {Promise<{valid: boolean, id?: string, name?: string, error?: string}>}
 */
async function verifyAccessToken(accessToken) {
  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me`;
    const response = await axios.get(url, {
      params: {
        fields: "id,name,email",
        access_token: accessToken,
      },
    });
    return {
      valid: true,
      id: response.data.id,
      name: response.data.name,
    };
  } catch (error) {
    console.error(
      "[Token Verification Error]",
      error.response?.data || error.message,
    );
    return {
      valid: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Fetch conversations (inbox or requests) from the Instagram Messaging edge
 * @param {string} userId
 * @param {object} options { folder: 'inbox'|'requests', limit, after }
 */
async function fetchConversations(userId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const { instagramBusinessAccountId } = session.graph;
  const accessToken = resolveGraphAccessToken(session.graph);
  const folder = options.folder || "inbox";
  const limit = options.limit || 25;
  const after = options.after || null;

  const baseUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instagramBusinessAccountId}/conversations`;
  const params = {
    access_token: accessToken,
    limit,
    fields:
      "id,thread_type,unread_count,participants,updated_time,link,last_message",
  };
  if (after) params.after = after;

  try {
    // Debug: log which token type and ids we're using (don't print actual tokens)
    try {
      const tokenType = session.graph?.facebookPageAccessToken
        ? "page"
        : session.graph?.facebookUserAccessToken
          ? "user"
          : "none";
      console.log(
        "[Instagram Fetch Conversations] using tokenType=%s instagramBusinessAccountId=%s pageId=%s",
        tokenType,
        instagramBusinessAccountId,
        session.graph?.facebookPageId || "none",
      );
    } catch (e) {
      // ignore logging errors
    }

    const response = await axios.get(baseUrl, { params });
    const data = response.data.data || [];
    const paging = response.data.paging || null;

    // Map to lightweight structure expected by frontend
    const mapped = data.map((c) => ({
      id: c.id,
      isRequest: (c.thread_type || "").toLowerCase().includes("request"),
      unread: c.unread_count || 0,
      participants: (c.participants || []).map((p) => ({
        id: p.id,
        name: p.name,
      })),
      lastMessage: c.last_message || null,
      updatedTime: c.updated_time || null,
    }));

    // If folder=requests, filter
    const filtered =
      folder === "requests"
        ? mapped.filter((m) => m.isRequest)
        : mapped.filter((m) => !m.isRequest);

    return { success: true, data: filtered, paging };
  } catch (error) {
    console.error(
      "[Instagram Fetch Conversations Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Fetch messages for a conversation
 */
async function fetchConversationMessages(userId, conversationId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  if (!conversationId)
    return { success: false, error: "conversationId required" };

  const accessToken = resolveGraphAccessToken(session.graph);
  const limit = options.limit || 25;
  const after = options.after || null;

  const baseUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${conversationId}/messages`;
  const params = {
    access_token: accessToken,
    limit,
    fields: "id,from,to,message,created_time,attachments",
  };
  if (after) params.after = after;

  try {
    const response = await axios.get(baseUrl, { params });
    const data = response.data.data || [];
    const paging = response.data.paging || null;

    const mapped = data.map((m) => ({
      id: m.id,
      from: m.from || null,
      to: m.to || null,
      text: m.message || null,
      createdTime: m.created_time || null,
      attachments: m.attachments || null,
    }));

    return { success: true, data: mapped, paging };
  } catch (error) {
    console.error(
      "[Instagram Fetch Conversation Messages Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Send a direct message via Instagram Messaging API
 * @param {string} userId
 * @param {object} payload { recipientId, message }
 */
async function sendDirectMessage(userId, payload = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const igId = session.graph.instagramBusinessAccountId;
  const accessToken = resolveGraphAccessToken(session.graph);
  if (!payload || !payload.recipientId || !payload.message) {
    return { success: false, error: "recipientId and message required" };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${igId}/messages`;
  const body = {
    recipient: { id: payload.recipientId },
    message: { text: payload.message },
    access_token: accessToken,
  };

  try {
    const response = await axios.post(url, body);
    return { success: true, data: response.data };
  } catch (error) {
    console.error(
      "[Instagram Send Direct Message Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Approve or decline a message request. This functionality may vary per app setup.
 * We'll implement an approve flow by POSTing to /{conversationId} with 'is_approved' param if supported.
 */
async function updateMessageRequest(
  userId,
  conversationId,
  action = "approve",
) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }
  if (!conversationId)
    return { success: false, error: "conversationId required" };

  const accessToken = resolveGraphAccessToken(session.graph);
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${conversationId}`;
  try {
    if (action === "approve") {
      const response = await axios.post(url, {
        access_token: accessToken,
        is_approved: true,
      });
      return { success: true, data: response.data };
    }
    if (action === "decline") {
      const response = await axios.post(url, {
        access_token: accessToken,
        is_declined: true,
      });
      return { success: true, data: response.data };
    }
    return { success: false, error: "unknown_action" };
  } catch (error) {
    console.error(
      "[Instagram Update Message Request Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Refresh access token if expired (optional)
 * @param {string} userId
 * @returns {Promise<{success: boolean, refreshed?: boolean}>}
 */
async function refreshTokenIfNeeded(userId) {
  // Implementation omitted for brevity; can be added later
  return { success: true, refreshed: false };
}

// Legacy functions for backward compatibility (will be deprecated)
async function loginInstagram(userId, username, password, opts = {}) {
  return {
    success: false,
    error: "Legacy login disabled. Please use OAuth flow.",
  };
}

async function submitChallengeCode(userId, code) {
  return { success: false, error: "Legacy challenge flow disabled." };
}

async function getInstagramClient(userId, opts = {}) {
  return null;
}

/**
 * Fetch recent notifications: likes, comments, and mentions from recent media
 * @param {string} userId
 * @param {object} options { limit, type: 'all'|'likes'|'comments'|'mentions' }
 */
async function fetchNotifications(userId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (
    !session ||
    !session.graph?.instagramBusinessAccountId ||
    !resolveGraphAccessToken(session.graph)
  ) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const { instagramBusinessAccountId } = session.graph;
  const accessToken = resolveGraphAccessToken(session.graph);
  const limit = options.limit || 50;
  const notificationType = options.type || "all";

  try {
    // Fetch recent media first
    const mediaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${instagramBusinessAccountId}/media`;
    const mediaParams = {
      access_token: accessToken,
      limit: 25, // get recent 25 media items
      fields: "id,caption,media_type,timestamp",
    };

    const mediaResponse = await axios.get(mediaUrl, { params: mediaParams });
    const medias = mediaResponse.data.data || [];
    const notifications = [];

    // For each media, fetch comments and likes
    for (const media of medias.slice(0, 10)) {
      // Process comments
      if (notificationType === "all" || notificationType === "comments") {
        try {
          const commentsUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${media.id}/comments`;
          const commentsParams = {
            access_token: accessToken,
            limit: 10,
            fields: "id,from,text,timestamp,like_count",
          };
          const commentsRes = await axios.get(commentsUrl, {
            params: commentsParams,
          });
          const comments = commentsRes.data.data || [];
          comments.slice(0, 5).forEach((c) => {
            notifications.push({
              id: c.id,
              type: "comment",
              actor: c.from?.name || c.from?.id || "Unknown",
              actorId: c.from?.id,
              text: c.text || "",
              mediaId: media.id,
              mediaCaption: (media.caption || "").substring(0, 50) + "...",
              timestamp: c.timestamp,
              likes: c.like_count || 0,
            });
          });
        } catch (e) {
          console.log(
            "[Notification] Comments fetch skipped for media",
            media.id,
          );
        }
      }

      // Process likes
      if (notificationType === "all" || notificationType === "likes") {
        try {
          const likesUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${media.id}/likes`;
          const likesParams = {
            access_token: accessToken,
            limit: 10,
            fields: "id,username,name",
          };
          const likesRes = await axios.get(likesUrl, { params: likesParams });
          const likes = likesRes.data.data || [];
          likes.slice(0, 3).forEach((l) => {
            notifications.push({
              id: l.id,
              type: "like",
              actor: l.name || l.username || "Unknown",
              actorId: l.id,
              text: "",
              mediaId: media.id,
              mediaCaption: (media.caption || "").substring(0, 50) + "...",
              timestamp: media.timestamp,
            });
          });
        } catch (e) {
          console.log("[Notification] Likes fetch skipped for media", media.id);
        }
      }

      if (notifications.length >= limit) break;
    }

    // Sort by timestamp desc and limit
    const sorted = notifications
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    return { success: true, data: sorted };
  } catch (error) {
    console.error(
      "[Instagram Fetch Notifications Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Reply to an Instagram comment
 * @param {string} userId
 * @param {string} commentId - The ID of the comment to reply to
 * @param {string} replyText - The text of the reply
 * @returns {Promise<{success: boolean, data?: Object, error?: string}>}
 */
async function replyToComment(userId, commentId, replyText) {
  const session = await InstagramSession.findOne({ userId });
  if (!session || !resolveGraphAccessToken(session.graph)) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/replies`;
  const params = {
    message: replyText,
    access_token: resolveGraphAccessToken(session.graph),
  };

  try {
    const response = await axios.post(url, {}, { params });
    return { success: true, data: response.data };
  } catch (error) {
    console.error(
      "[Instagram Reply Comment Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Like a comment on Instagram
 * @param {string} userId
 * @param {string} commentId
 * @returns {Promise<{success: boolean, data?: object, error?: string}>}
 */
async function likeComment(userId, commentId) {
  const session = await InstagramSession.findOne({ userId });
  if (!session || !resolveGraphAccessToken(session.graph)) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/likes`;
  const params = {
    access_token: resolveGraphAccessToken(session.graph),
  };

  try {
    const response = await axios.post(url, {}, { params });
    return { success: true, data: response.data };
  } catch (error) {
    console.error(
      "[Instagram Like Comment Error]",
      error.response?.data || error.message,
    );
    return {
      success: false,
      error: error.response?.data?.error?.message || error.message,
    };
  }
}

/**
 * Fetch recent media with their comments
 * @param {string} userId
 * @param {object} options
 * @returns {Promise<{success: boolean, data?: Array, error?: string}>}
 */
async function fetchRecentMediaWithComments(userId, options = {}) {
  const session = await InstagramSession.findOne({ userId });
  if (!session || !resolveGraphAccessToken(session.graph)) {
    return { success: false, error: "No valid Instagram Graph API session" };
  }

  const businessAccountId = session?.graph?.instagramBusinessAccountId;
  if (!businessAccountId) {
    return {
      success: false,
      error: "No Instagram business account connected",
    };
  }

  try {
    // Fetch recent media
    const mediaUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${businessAccountId}/media`;
    const mediaParams = {
      fields:
        "id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count",
      access_token: resolveGraphAccessToken(session.graph),
      limit: options.limit || 10,
    };

    console.log(
      `[Fetch Media] URL: ${mediaUrl}, Limit: ${options.limit || 10}`,
    );
    const mediaRes = await axios.get(mediaUrl, { params: mediaParams });
    const mediaList = mediaRes.data.data || [];
    console.log(`[Fetch Media] Retrieved ${mediaList.length} media items`);

    // Fetch comments for each media
    const mediaWithComments = [];
    let totalCommentsFetched = 0;

    for (const media of mediaList) {
      const commentsUrl = `https://graph.facebook.com/${GRAPH_API_VERSION}/${media.id}/comments`;
      const commentsParams = {
        fields: "id,text,username,timestamp,like_count",
        access_token: resolveGraphAccessToken(session.graph),
        limit: options.commentsLimit || 100,
      };

      try {
        console.log(
          `[Fetch Comments] Fetching for media ${media.id} (${media.media_type})`,
        );
        const commentsRes = await axios.get(commentsUrl, {
          params: commentsParams,
        });
        const comments = commentsRes.data.data || [];
        console.log(
          `[Fetch Comments] Got ${comments.length} comments for media ${media.id}`,
        );
        mediaWithComments.push({
          ...media,
          comments,
        });
        totalCommentsFetched += comments.length;
      } catch (e) {
        const errorMsg =
          e.response?.data?.error?.message || e.message || "Unknown error";
        console.error(
          `[Fetch Comments] Error for media ${media.id}: ${errorMsg}`,
        );
        // Still add media with empty comments
        mediaWithComments.push({
          ...media,
          comments: [],
        });
      }
    }

    console.log(
      `[Fetch Media With Comments] Total comments fetched: ${totalCommentsFetched}`,
    );
    return { success: true, data: mediaWithComments };
  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.error("[Instagram Fetch Media With Comments Error]", errorMsg);
    return {
      success: false,
      error: errorMsg,
    };
  }
}

export default {
  // New Graph API functions
  getOAuthUrl,
  createOAuthState,
  parseOAuthState,
  buildConnectRedirect,
  exchangeCodeForToken,
  getLongLivedToken,
  handleOAuthCallback,
  checkSessionStatus,
  removeSession,
  fetchMedia,
  // counts helper
  countMediaByType,
  fetchComments,
  replyToComment,
  likeComment,
  fetchRecentMediaWithComments,
  verifyAccessToken,
  refreshTokenIfNeeded,
  // DMs
  fetchConversations,
  fetchConversationMessages,
  sendDirectMessage,
  updateMessageRequest,
  // Notifications
  fetchNotifications,
  // Legacy functions (to be removed eventually)
  loginInstagram,
  submitChallengeCode,
  getInstagramClient,
};
