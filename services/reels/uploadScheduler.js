import Reel from "../../models/Reel.js";
import ReelCampaign from "../../models/ReelCampaign.js";
import { uploadReel } from "./instagramUploadService.js";
import { generateCaptionForPart } from "./aiCaptionService.js";
import { getInstagramCredentials } from "./instagramCredentialsService.js";
import fs from "fs";

let isRunning = false;
let checkInterval = null;

/**
 * Start the upload scheduler service
 * Checks every 30 seconds for pending reels that should be uploaded
 */
export function startUploadScheduler(io) {
  if (isRunning) {
    console.log("[📅 SCHEDULER] Upload scheduler already running");
    return;
  }

  isRunning = true;
  console.log("[📅 SCHEDULER] Starting reel upload scheduler...");

  checkInterval = setInterval(async () => {
    try {
      await checkAndProcessPendingReels(io);
    } catch (err) {
      console.error(`[❌ SCHEDULER] Error:`, err?.message || err);
    }
  }, 30000); // Check every 30 seconds
}

/**
 * Stop the upload scheduler service
 */
export function stopUploadScheduler() {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
    isRunning = false;
    console.log("[📅 SCHEDULER] Upload scheduler stopped");
  }
}

/**
 * Check for pending reels that are ready to upload
 */
async function checkAndProcessPendingReels(io) {
  try {
    // Find all reels that are pending and scheduledFor is in the past
    const now = new Date();
    const pendingReels = await Reel.find({
      status: "pending",
      scheduledFor: { $lte: now },
    }).populate("campaign");

    if (pendingReels.length === 0) return;

    console.log(
      `[📅 SCHEDULER] Found ${pendingReels.length} reels ready for upload`,
    );

    for (const reel of pendingReels) {
      try {
        const campaign = reel.campaign;

        // Skip if campaign is paused or deleted
        if (!campaign) {
          console.log(`[⚠️ SCHEDULER] Campaign not found for reel ${reel._id}`);
          await Reel.findByIdAndUpdate(reel._id, {
            status: "failed",
            error: "Campaign not found",
          });
          continue;
        }

        if (campaign.status === "paused") {
          console.log(
            `[⏸️ SCHEDULER] Campaign paused, skipping reel ${reel._id}`,
          );
          continue;
        }

        console.log(
          `[📤 SCHEDULER] Uploading reel ${reel._id} to Instagram...`,
        );
        await uploadReelToInstagram(reel, campaign, io);
      } catch (err) {
        console.error(
          `[❌ SCHEDULER] Error uploading reel ${reel._id}:`,
          err?.message || err,
        );
      }
    }
  } catch (err) {
    console.error(
      `[❌ SCHEDULER] Error checking pending reels:`,
      err?.message || err,
    );
  }
}

/**
 * Upload a reel to Instagram
 */
async function uploadReelToInstagram(reel, campaign, io) {
  try {
    // Update status to uploading
    await Reel.findByIdAndUpdate(reel._id, { status: "uploading" });

    // Emit event to frontend
    if (io && campaign.owner) {
      io.to(`user:${campaign.owner}`).emit("reel:uploading", {
        reelId: reel._id,
        campaignId: campaign._id,
        message: `Uploading reel ${reel.index}...`,
      });
    }

    // Use stored caption data or generate new
    let captionData = reel.captionData;
    let caption = reel.caption;

    if (!captionData) {
      const ai = await generateCaptionForPart({
        campaignTitle: campaign.campaignTitle,
        youtubeTitle: campaign.youtubeTitle,
        index: reel.index,
        tone: campaign.captionTone || "Viral",
        hashtagCount: campaign.hashtagCount || 5,
      });

      captionData = {
        title: ai.title || `Part ${reel.index}`,
        hook: ai.hook || "",
        cta: ai.cta || "Learn more",
        caption: ai.caption || "",
        hashtags: ai.hashtags || [],
      };

      caption = `${ai.hook || ""}\n\n${ai.caption || ""}\n\n${(ai.hashtags || []).join(" ")}`;

      await Reel.findByIdAndUpdate(reel._id, {
        captionData,
        caption,
        hashtags: ai.hashtags || [],
      });
    }

    // Get Instagram credentials from user's connected session
    let instagramCredentials;
    try {
      instagramCredentials = await getInstagramCredentials(campaign.owner);
    } catch (credentialError) {
      throw new Error(`Cannot upload: ${credentialError.message}`);
    }

    const accessToken = instagramCredentials.accessToken;
    const igUserId = instagramCredentials.igUserId;

    console.log(`[📤 SCHEDULER] Uploading reel ${reel._id} to Instagram...`);
    console.log(
      `[📤 SCHEDULER] Using ${instagramCredentials.method} credentials for reel ${reel._id}`,
    );
    console.log(`[📤 SCHEDULER] Credentials debug:`);
    console.log(
      `   - accessToken length: ${instagramCredentials.accessToken ? instagramCredentials.accessToken.length : 0}`,
    );
    console.log(
      `   - accessToken prefix: ${instagramCredentials.accessToken ? instagramCredentials.accessToken.substring(0, 20) + "..." : "N/A"}`,
    );
    console.log(`   - igUserId: ${instagramCredentials.igUserId}`);

    // Upload to Instagram
    const uploadResult = await uploadReel({
      filePath: reel.path,
      videoUrl: reel.videoUrl,
      caption,
      captionData,
      accessToken: instagramCredentials.accessToken,
      igUserId: instagramCredentials.igUserId,
    });

    // Update reel with upload result
    await Reel.findByIdAndUpdate(reel._id, {
      instagramMediaId: uploadResult.mediaId,
      instagramPermalink: uploadResult.permalink,
      status: "uploaded",
      error: null,
    });

    // Increment campaign uploaded count
    await ReelCampaign.findByIdAndUpdate(campaign._id, {
      $inc: { uploadedReels: 1 },
    });

    // Emit success event
    if (io && campaign.owner) {
      io.to(`user:${campaign.owner}`).emit("reel:uploaded", {
        reelId: reel._id,
        campaignId: campaign._id,
        mediaId: uploadResult.mediaId,
        permalink: uploadResult.permalink,
        message: `Reel ${reel.index} uploaded successfully!`,
      });
    }

    console.log(`[✅ SCHEDULER] Reel ${reel._id} uploaded successfully!`);

    // Delete file if auto-delete is enabled
    if (campaign.autoDelete) {
      try {
        fs.unlinkSync(reel.path);
      } catch (e) {}
    }
  } catch (err) {
    console.error(`[❌ SCHEDULER] Upload error:`, err?.message || err);

    const rawMsg = String(err?.message || "");
    const isInstagramProcessingError =
      rawMsg.includes("Instagram media processing failed") ||
      rawMsg.includes('"status_code":"ERROR"') ||
      rawMsg.includes("Media upload has failed");

    // Update reel with error (shorten message for known processing failures)
    await Reel.findByIdAndUpdate(reel._id, {
      status: "failed",
      error: isInstagramProcessingError
        ? "Instagram media processing failed"
        : err?.message || "Upload failed",
    });

    // Increment campaign failed count
    await ReelCampaign.findByIdAndUpdate(campaign._id, {
      $inc: { failedReels: 1 },
    });

    // Emit error event
    if (io && campaign.owner) {
      io.to(`user:${campaign.owner}`).emit("reel:upload-failed", {
        reelId: reel._id,
        campaignId: campaign._id,
        error: isInstagramProcessingError
          ? "Instagram media processing failed"
          : err?.message || "Upload failed",
      });
    }

    // If this is an Instagram processing error, do NOT rethrow — skip to next reel.
    if (isInstagramProcessingError) {
      console.warn(
        `[⚠️ SCHEDULER] Instagram processing error for reel ${reel._id}, skipping to next reel.`,
      );
      return;
    }

    throw err;
  }
}

export function isSchedulerRunning() {
  return isRunning;
}
