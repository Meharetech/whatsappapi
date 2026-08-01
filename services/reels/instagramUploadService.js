import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import axios from "axios";

/**
 * Upload reel to Instagram using Meta Graph API v18.0+
 * Supports: title, description (caption), hashtags
 *
 * @param {Object} params
 * @param {string} params.filePath - Local path to video file
 * @param {string} params.caption - Full caption text (for backward compatibility)
 * @param {Object} params.captionData - Structured caption with title, hook, cta, caption, hashtags
 * @param {string} params.accessToken - Instagram Business Account access token
 * @param {string} params.igUserId - Instagram Business Account ID (not user ID)
 * @returns {Promise<{mediaId: string, permalink: string}>}
 */
export async function uploadReel({
  filePath,
  videoUrl,
  caption,
  captionData,
  accessToken,
  igUserId,
}) {
  console.log(
    `[📤 UPLOAD] Starting Instagram reel upload for: ${filePath || videoUrl}`,
  );
  console.log(`[📤 UPLOAD] Debug Info:`);
  console.log(`   - igUserId: ${igUserId}`);
  console.log(
    `   - accessToken length: ${accessToken ? accessToken.length : 0}`,
  );
  console.log(
    `   - accessToken prefix: ${accessToken ? accessToken.substring(0, 20) + "..." : "N/A"}`,
  );
  console.log(
    `   - video source: ${filePath ? "local" : videoUrl ? "remote" : "unknown"}`,
  );
  console.log(`   - caption length: ${caption ? caption.length : 0}`);

  // Build the caption text from structured data
  let finalCaption = caption; // fallback to legacy string

  if (captionData) {
    const {
      title,
      hook,
      cta,
      caption: mainCaption,
      hashtags = [],
    } = captionData;

    // Format: title + hook + caption + CTA + hashtags
    const parts = [
      title && `✨ ${title}`,
      hook && `\n\n🎯 ${hook}`,
      mainCaption && `\n\n${mainCaption}`,
      cta && `\n\n👉 ${cta}`,
      hashtags.length > 0 &&
        `\n\n${hashtags.map((tag) => (tag.startsWith("#") ? tag : `#${tag}`)).join(" ")}`,
    ].filter(Boolean);

    finalCaption = parts.join("");
    console.log(
      `[📤 UPLOAD] Caption formatted from captionData (length: ${finalCaption.length})`,
    );
  }

  // Truncate caption if needed (Instagram limit is 2200 chars for Reels)
  if (finalCaption && finalCaption.length > 2200) {
    console.warn(
      `[⚠️ UPLOAD] Caption too long (${finalCaption.length} chars), truncating to 2200...`,
    );
    finalCaption = finalCaption.substring(0, 2197) + "...";
  }

  // Build public URL for video file. Prefer explicit `videoUrl`, else accept remote `filePath` URLs, else build from local `filePath`.
  let publicUrl = videoUrl || null;
  if (!publicUrl) {
    if (filePath && /^https?:\/\//i.test(filePath)) {
      publicUrl = filePath;
    } else {
      publicUrl = `${process.env.PUBLIC_BASE_URL || "http://localhost:3000"}/uploads/${path
        .relative(process.cwd() + "/uploads", filePath)
        .replace(/\\/g, "/")}`;
    }
  }

  console.log(`[📤 UPLOAD] Public URL: ${publicUrl}`);

  try {
    // VALIDATE TOKEN FORMAT
    console.log(`[📤 UPLOAD] Validating access token...`);
    const tokenPrefix = accessToken ? accessToken.substring(0, 20) : "N/A";
    console.log(`   - Token prefix: ${tokenPrefix}...`);
    console.log(`   - Token length: ${accessToken ? accessToken.length : 0}`);

    // Check if token looks like a JWT (starts with eyJ) vs Meta token (starts with EAA)
    if (accessToken && accessToken.startsWith("eyJ")) {
      console.error(
        `[❌ UPLOAD] ERROR: Sending JWT token instead of Meta token!`,
      );
      console.error(
        `   This is the backend JWT token, NOT the Instagram access token.`,
      );
      console.error(`   Need: Facebook User Access Token (starts with EAA...)`);
      throw new Error(
        "Invalid token type: JWT detected instead of Meta access token. Check Instagram session credentials.",
      );
    }

    if (!accessToken || !accessToken.startsWith("EAA")) {
      console.warn(`[⚠️ UPLOAD] Token doesn't start with EAA - may be invalid`);
      console.warn(`   Expected format: EAAxxxxx...`);
      console.warn(`   Got: ${tokenPrefix}...`);
    }

    // STEP 1: Create media container
    console.log(`[📤 UPLOAD] Creating media container...`);
    console.log(`[📤 UPLOAD] Request params:`);
    console.log(
      `   - Endpoint: https://graph.facebook.com/v22.0/${igUserId}/media`,
    );
    console.log(`   - Media Type: REELS`);
    console.log(`   - Video URL: ${publicUrl}`);
    console.log(`   - Caption length: ${(finalCaption || "").length}`);
    console.log(
      `   - Token format: ${accessToken?.startsWith("EAA") ? "Meta token ✅" : "INVALID ❌"}`,
    );

    const createRes = await axios.post(
      `https://graph.facebook.com/v22.0/${igUserId}/media`,
      null,
      {
        params: {
          media_type: "REELS",
          video_url: publicUrl,
          caption: finalCaption || "",
          access_token: accessToken,
        },
        headers: { "Content-Type": "application/json" },
      },
    );

    console.log(`[📤 UPLOAD] Response status: ${createRes.status}`);
    const createJson = createRes.data;
    console.log(
      `[📤 UPLOAD] Response body:`,
      JSON.stringify(createJson).substring(0, 500),
    );

    if (!createJson?.id) {
      const errorMsg = JSON.stringify(createJson);

      // Enhanced error debugging
      if (createJson?.error?.code === 190) {
        console.error(`[❌ UPLOAD] OAuth Token Error (Code 190):`);
        console.error(`   Message: ${createJson.error.message}`);
        console.error(
          `   Token prefix: ${accessToken ? accessToken.substring(0, 30) : "missing"}...`,
        );
        console.error(`   igUserId: ${igUserId}`);
        console.error(`   This usually means:`);
        console.error(
          `   1. Token is expired (check expiration date in database)`,
        );
        console.error(
          `   2. Token doesn't have instagram_content_publish scope`,
        );
        console.error(
          `   3. Instagram Business Account ID is wrong or not linked`,
        );
        console.error(`   4. App is not approved for this token`);
        console.error(
          `   Facebook Trace: ${createJson.error.fbtrace_id || "N/A"}`,
        );
      } else if (createJson?.error?.code === 400) {
        console.error(`[❌ UPLOAD] Bad Request (Code 400):`);
        console.error(`   Message: ${createJson.error.message}`);
        console.error(
          `   This usually means the video URL or video format is invalid`,
        );
        console.error(`   Video URL: ${publicUrl}`);
      }

      throw new Error(`Create container failed: ${errorMsg}`);
    }

    const mediaContainerId = createJson.id;
    console.log(`[✅ UPLOAD] Media container created: ${mediaContainerId}`);

    // STEP 2: Wait until Meta finishes processing the reel container
    const maxStatusChecks = 20;
    const statusCheckDelayMs = 5000;
    let statusCode = "IN_PROGRESS";

    console.log(
      `[📤 UPLOAD] Waiting for media processing (max ${(maxStatusChecks * statusCheckDelayMs) / 1000}s)...`,
    );

    for (let attempt = 1; attempt <= maxStatusChecks; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, statusCheckDelayMs));

      const statusRes = await axios.get(
        `https://graph.facebook.com/v22.0/${mediaContainerId}`,
        {
          params: {
            fields: "status_code,status",
            access_token: accessToken,
          },
        },
      );

      statusCode = statusRes?.data?.status_code || "IN_PROGRESS";
      console.log(
        `[📤 UPLOAD] Container status (${attempt}/${maxStatusChecks}): ${statusCode}`,
      );

      if (statusCode === "FINISHED") {
        console.log(`[✅ UPLOAD] Media container is ready for publish`);
        break;
      }

      if (statusCode === "ERROR") {
        throw new Error(
          `Instagram media processing failed: ${JSON.stringify(statusRes?.data || {})}`,
        );
      }
    }

    if (statusCode !== "FINISHED") {
      throw new Error(
        `Media processing timeout after ${(maxStatusChecks * statusCheckDelayMs) / 1000}s`,
      );
    }

    // STEP 3: Publish media (finalize upload)
    console.log(`[📤 UPLOAD] Publishing media...`);
    const publishRes = await axios.post(
      `https://graph.facebook.com/v22.0/${igUserId}/media_publish`,
      null,
      {
        params: {
          creation_id: mediaContainerId,
          access_token: accessToken,
        },
      },
    );

    const pubJson = publishRes.data;
    if (!pubJson?.id) {
      throw new Error(`Publish failed: ${JSON.stringify(pubJson)}`);
    }

    const mediaId = pubJson.id;
    console.log(`[✅ UPLOAD] Media published: ${mediaId}`);

    // STEP 4: Get permalink
    console.log(`[📤 UPLOAD] Fetching media permalink...`);
    const metaRes = await axios.get(
      `https://graph.facebook.com/v22.0/${mediaId}`,
      {
        params: {
          fields: "permalink,media_type,caption",
          access_token: accessToken,
        },
      },
    );

    const metaJson = metaRes.data;
    const permalink = metaJson?.permalink || "";

    console.log(`[✅ UPLOAD] Upload complete! Permalink: ${permalink}`);

    return {
      mediaId,
      permalink,
      mediaType: metaJson?.media_type,
    };
  } catch (err) {
    console.error(`[❌ UPLOAD] Caught error:`);
    console.error(`   - Error type: ${err?.name || "Unknown"}`);
    console.error(`   - Message: ${err?.message || "No message"}`);

    // Log detailed Meta error response
    if (err.response?.data) {
      console.error(`[❌ UPLOAD] Meta API Error Response:`);
      console.error(JSON.stringify(err.response.data, null, 2));
    }

    if (err.response?.status) {
      console.error(`   - HTTP Status: ${err.response.status}`);
    }

    console.error(`[❌ UPLOAD] Full error:`, err);
    throw err;
  }
}
