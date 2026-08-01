import ReelCampaign from "../models/ReelCampaign.js";
import Reel from "../models/Reel.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { downloadVideoFromSource } from "../services/reels/youtubeDownloadService.js";
import { splitVideoToClips } from "../services/reels/ffmpegSplitService.js";
import { generateCaptionForPart } from "../services/reels/aiCaptionService.js";
import { uploadReel } from "../services/reels/instagramUploadService.js";
import { addReelJob } from "../services/reels/reelQueue.js";
import { getInstagramCredentials } from "../services/reels/instagramCredentialsService.js";

let io = null;
export function setSocketIO(ioInstance) {
  io = ioInstance;
}

function isPinterestVideoUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      /(^|\.)pinimg\.com$/i.test(parsed.hostname) ||
      /(^|\.)pinterest\.com$/i.test(parsed.hostname)
    );
  } catch (error) {
    return false;
  }
}

function emitProgress(userId, campaignId, event) {
  if (io) {
    io.to(`user:${userId}`).emit("reel:progress", { campaignId, ...event });
    console.log(`[📡 EMIT] ${event.stage}: ${JSON.stringify(event)}`);
  }
}

export async function createCampaign(req, res) {
  try {
    const body = req.body;
    const owner = req.user?._id;
    const reelLengthSec = parseInt(body.reelLengthSec, 10) || 60;
    const sourceType = body.sourceType || "youtube";
    const sourceUrl = body.sourceUrl || body.youtubeUrl;
    const sourceTitle =
      body.sourceTitle || body.youtubeTitle || body.campaignTitle;

    // For Pinterest with posts array, sourceUrl is not required
    const isPinterestWithPosts =
      sourceType === "pinterest" &&
      Array.isArray(body.posts) &&
      body.posts.length > 0;

    if (!sourceUrl && !isPinterestWithPosts) {
      return res.status(400).json({ error: "sourceUrl is required" });
    }

    console.log(
      `[🎬 CAMPAIGN] Creating ${sourceType} campaign: ${body.campaignTitle}`,
    );

    const campaign = await ReelCampaign.create({
      sourceType,
      sourceUrl: sourceUrl || "",
      sourceTitle,
      youtubeUrl: sourceUrl || "",
      youtubeTitle: sourceTitle,
      campaignTitle: body.campaignTitle,
      reelLengthSec,
      uploadGapMinutes: parseInt(body.uploadGapMinutes, 10) || 60,
      captionTone: body.captionTone,
      hashtagCount: parseInt(body.hashtagCount, 10) || 5,
      autoDelete: !!body.autoDelete,
      autoStart: !!body.autoStart,
      owner,
      status: "processing",
    });

    emitProgress(owner, campaign._id, {
      stage: "created",
      message: "Campaign created",
    });

    // STEP 1: Download (or prepare Pinterest posts)
    const sourceLabel = sourceType === "pinterest" ? "Pinterest" : "source";
    console.log(`[🎬 CAMPAIGN] STEP 1: Preparing ${sourceLabel} source...`);
    emitProgress(owner, campaign._id, {
      stage: "preparing",
      message: `Preparing ${sourceLabel} source...`,
    });

    const reels = [];

    // If Pinterest and frontend provided selected posts, skip download/split and use remote mp4 URLs
    if (
      sourceType === "pinterest" &&
      Array.isArray(body.posts) &&
      body.posts.length > 0
    ) {
      const posts = body.posts;
      campaign.totalReels = posts.length;
      await campaign.save();

      emitProgress(owner, campaign._id, {
        stage: "prepared",
        message: `Prepared ${posts.length} Pinterest posts`,
      });

      for (let i = 0; i < posts.length; i++) {
        const item = posts[i] || {};
        const videoUrl =
          item.downloadUrl || item.videoUrl || item.url || item.mp4 || null;
        const thumbnail = item.thumbnail || item.image || null;

        console.log(
          `[🎬 CAMPAIGN] Generating caption for Pinterest post ${i + 1}/${posts.length}`,
        );
        emitProgress(owner, campaign._id, {
          stage: "captioning",
          current: i + 1,
          total: posts.length,
        });

        const ai = await generateCaptionForPart({
          campaignTitle: campaign.campaignTitle,
          youtubeTitle: campaign.sourceTitle || campaign.youtubeTitle || "",
          index: i + 1,
          tone: campaign.captionTone || "Viral",
          hashtagCount: campaign.hashtagCount || 5,
        });

        const scheduledFor = new Date(
          Date.now() + i * campaign.uploadGapMinutes * 60_000,
        );

        const reelDoc = await Reel.create({
          campaign: campaign._id,
          index: i + 1,
          // store remote public URL instead of local path
          videoUrl,
          thumbnail,

          // Store structured caption data from AI
          captionData: {
            title:
              ai.title ||
              `${campaign.campaignTitle || campaign.sourceTitle || "Reel status"}`,
            hook: ai.hook || "",
            cta: ai.cta || "Learn more",
            caption: ai.caption || "",
            hashtags: ai.hashtags || [],
          },

          // Legacy: construct string caption as well
          caption: `${ai.hook || ""}\n\n${ai.caption || ""}\n\n${(ai.hashtags || []).join(" ")}`,
          hashtags: ai.hashtags || [],

          scheduledFor,
          status: scheduledFor <= new Date() ? "pending" : "pending",
        });

        reels.push(reelDoc);

        const delay = Math.max(0, new Date(scheduledFor) - new Date());
        await addReelJob(
          "uploadReel",
          { type: "uploadReel", reelId: reelDoc._id },
          { delay },
        );
      }

      campaign.status = "running";
      await campaign.save();

      console.log(
        `[✅ CAMPAIGN] Campaign creation complete! ${posts.length} reels created.`,
      );
      emitProgress(owner, campaign._id, {
        stage: "complete",
        message: "Campaign ready!",
        reelCount: posts.length,
      });

      return res.json({ success: true, campaign, reels });
    }

    // FALLBACK: original download -> split -> create clips flow
    console.log(`[🎬 CAMPAIGN] STEP 1: Downloading ${sourceLabel} video...`);
    emitProgress(owner, campaign._id, {
      stage: "downloading",
      message: `Downloading ${sourceLabel} video...`,
    });

    const downloaded = await downloadVideoFromSource(
      campaign.sourceUrl || campaign.youtubeUrl,
      campaign.campaignTitle || "youtube",
      (prog) =>
        emitProgress(owner, campaign._id, { stage: "downloading", ...prog }),
    );
    campaign.tempDownloadPath = downloaded;
    await campaign.save();

    emitProgress(owner, campaign._id, {
      stage: "downloaded",
      message: "Video downloaded successfully",
    });

    // STEP 2: Split
    console.log(`[🎬 CAMPAIGN] STEP 2: Splitting video into clips...`);
    emitProgress(owner, campaign._id, {
      stage: "splitting",
      message: "Splitting video into clips...",
    });

    const clips = await splitVideoToClips(
      downloaded,
      campaign.reelLengthSec,
      (prog) =>
        emitProgress(owner, campaign._id, { stage: "splitting", ...prog }),
    );
    campaign.totalReels = clips.length;
    await campaign.save();

    emitProgress(owner, campaign._id, {
      stage: "split",
      message: `Video split into ${clips.length} clips`,
    });

    // STEP 3: create Reel documents and schedule uploads
    console.log(
      `[🎬 CAMPAIGN] STEP 3: Generating AI captions for ${clips.length} clips...`,
    );
    emitProgress(owner, campaign._id, {
      stage: "captioning",
      message: "Generating AI captions...",
    });

    for (let i = 0; i < clips.length; i++) {
      const clipPath = clips[i];

      console.log(
        `[🎬 CAMPAIGN] Generating caption ${i + 1}/${clips.length}...`,
      );
      emitProgress(owner, campaign._id, {
        stage: "captioning",
        current: i + 1,
        total: clips.length,
      });

      const ai = await generateCaptionForPart({
        campaignTitle: campaign.campaignTitle,
        youtubeTitle: campaign.sourceTitle || campaign.youtubeTitle || "",
        index: i + 1,
        tone: campaign.captionTone || "Viral",
        hashtagCount: campaign.hashtagCount || 5,
      });

      const scheduledFor = new Date(
        Date.now() + i * campaign.uploadGapMinutes * 60_000,
      );

      const reelDoc = await Reel.create({
        campaign: campaign._id,
        index: i + 1,
        path: clipPath,

        // Store structured caption data from AI
        captionData: {
          title:
            ai.title ||
            `${campaign.campaignTitle || campaign.sourceTitle || "Reel status"}`,
          hook: ai.hook || "",
          cta: ai.cta || "Learn more",
          caption: ai.caption || "",
          hashtags: ai.hashtags || [],
        },

        // Legacy: construct string caption as well
        caption: `${ai.hook || ""}\n\n${ai.caption || ""}\n\n${(ai.hashtags || []).join(" ")}`,
        hashtags: ai.hashtags || [],

        scheduledFor,
        status: scheduledFor <= new Date() ? "pending" : "pending",
      });

      reels.push(reelDoc);

      // schedule job in BullMQ with delay equal to scheduledFor - now
      const delay = Math.max(0, new Date(scheduledFor) - new Date());
      await addReelJob(
        "uploadReel",
        { type: "uploadReel", reelId: reelDoc._id },
        { delay },
      );
    }

    campaign.status = "running";
    await campaign.save();

    console.log(
      `[✅ CAMPAIGN] Campaign creation complete! ${clips.length} reels created.`,
    );
    emitProgress(owner, campaign._id, {
      stage: "complete",
      message: "Campaign ready!",
      reelCount: clips.length,
    });

    res.json({ success: true, campaign, reels });
  } catch (err) {
    console.error(`[❌ CAMPAIGN] Error: ${err.message}`, err);
    emitProgress(req.user?._id, null, { stage: "error", message: err.message });
    res.status(500).json({ error: err.message });
  }
}

export async function proxyPreviewVideo(req, res) {
  try {
    const sourceUrl = String(req.query.url || "").trim();

    if (!sourceUrl) {
      return res.status(400).json({ error: "url is required" });
    }

    if (!/^https?:\/\//i.test(sourceUrl)) {
      return res.status(400).json({ error: "Only http(s) URLs are allowed" });
    }

    if (!isPinterestVideoUrl(sourceUrl)) {
      return res
        .status(400)
        .json({ error: "Only Pinterest video URLs are allowed" });
    }

    const upstream = await axios.get(sourceUrl, {
      responseType: "stream",
      timeout: 30000,
      headers: {
        Range: req.headers.range,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Referer: "https://www.pinterest.com/",
        Origin: "https://www.pinterest.com",
        Accept: req.headers.accept || "video/*,*/*;q=0.8",
      },
      validateStatus: (status) => status >= 200 && status < 400,
    });

    const contentType = upstream.headers["content-type"] || "video/mp4";
    const contentLength = upstream.headers["content-length"];
    const acceptRanges = upstream.headers["accept-ranges"] || "bytes";
    const contentRange = upstream.headers["content-range"];

    res.setHeader("Content-Type", contentType);
    res.setHeader("Accept-Ranges", acceptRanges);
    res.setHeader("Cache-Control", "no-store");
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (contentRange) res.setHeader("Content-Range", contentRange);

    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (error) {
    console.error("[❌ PREVIEW] Proxy failed:", error?.message || error);
    return res.status(502).json({
      error: "Unable to load preview video",
      details: error?.message || "Unknown proxy error",
    });
  }
}

export async function listCampaigns(req, res) {
  const owner = req.user?._id;
  const items = await ReelCampaign.find({ owner }).sort({ createdAt: -1 });
  res.json(items);
}

export async function getCampaign(req, res) {
  const id = req.params.id;
  const campaign = await ReelCampaign.findById(id);
  if (!campaign) return res.status(404).json({ error: "Not found" });
  const reels = await Reel.find({ campaign: campaign._id }).sort({ index: 1 });
  res.json({ campaign, reels });
}

export async function retryReel(req, res) {
  const reelId = req.params.id;
  const reel = await Reel.findById(reelId).populate("campaign");
  if (!reel) return res.status(404).json({ error: "Not found" });

  try {
    const campaign = reel.campaign;

    // Prevent upload if campaign is paused
    if (campaign.status === "paused") {
      return res.status(400).json({
        error: "Cannot upload - campaign is paused. Resume campaign first.",
      });
    }

    // Update status to uploading
    await Reel.findByIdAndUpdate(reelId, { status: "uploading" });

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
        title:
          ai.title ||
          `${campaign.campaignTitle || campaign.sourceTitle || "Reel status"}`,
        hook: ai.hook || "",
        cta: ai.cta || "Learn more",
        caption: ai.caption || "",
        hashtags: ai.hashtags || [],
      };

      caption = `${ai.hook || ""}\n\n${ai.caption || ""}\n\n${(ai.hashtags || []).join(" ")}`;

      await Reel.findByIdAndUpdate(reelId, {
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

    console.log(
      `[📤 RETRY] Uploading reel ${reelId} using ${instagramCredentials.method} credentials...`,
    );

    // Upload to Instagram
    const uploadResult = await uploadReel({
      filePath: reel.path,
      videoUrl: reel.videoUrl,
      caption,
      captionData,
      accessToken,
      igUserId,
    });

    // Update reel with upload result
    await Reel.findByIdAndUpdate(reelId, {
      instagramMediaId: uploadResult.mediaId,
      instagramPermalink: uploadResult.permalink,
      status: "uploaded",
      error: null,
    });

    // Increment campaign uploaded count
    await ReelCampaign.findByIdAndUpdate(campaign._id, {
      $inc: { uploadedReels: 1, failedReels: -1 },
    });

    console.log(`[✅ RETRY] Reel uploaded successfully!`);
    res.json({ success: true, mediaId: uploadResult.mediaId });
  } catch (err) {
    console.error(`[❌ RETRY] Upload failed:`, err?.message || err);

    // Update reel with error
    await Reel.findByIdAndUpdate(reelId, {
      status: "failed",
      error: err?.message || "Upload failed",
    });

    res.status(500).json({ error: err?.message || "Upload failed" });
  }
}

export async function deleteReel(req, res) {
  const reelId = req.params.id;
  const reel = await Reel.findById(reelId);
  if (!reel) return res.status(404).json({ error: "Not found" });
  try {
    fs.unlinkSync(reel.path);
  } catch (e) {}
  await Reel.deleteOne({ _id: reelId });
  res.json({ success: true });
}

export async function deleteCampaign(req, res) {
  const campaignId = req.params.id;
  const owner = req.user?._id;

  const campaign = await ReelCampaign.findOne({
    _id: campaignId,
    owner,
  });

  if (!campaign) return res.status(404).json({ error: "Not found" });

  const reels = await Reel.find({ campaign: campaign._id });

  for (const reel of reels) {
    try {
      if (reel.path) fs.unlinkSync(reel.path);
    } catch (e) {}
  }

  try {
    if (campaign.tempDownloadPath) fs.unlinkSync(campaign.tempDownloadPath);
  } catch (e) {}

  await Reel.deleteMany({ campaign: campaign._id });
  await ReelCampaign.deleteOne({ _id: campaign._id });

  res.json({ success: true });
}

export async function pauseCampaign(req, res) {
  const campaignId = req.params.id;
  const owner = req.user?._id;

  const campaign = await ReelCampaign.findOne({
    _id: campaignId,
    owner,
  });

  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status === "paused") {
    return res.status(400).json({ error: "Campaign is already paused" });
  }

  // Store the previous status to restore when resumed
  campaign.previousStatus = campaign.status;
  campaign.status = "paused";
  await campaign.save();

  console.log(`[⏸️  PAUSE] Campaign paused: ${campaignId}`);

  // Emit pause event
  if (io) {
    io.to(`user:${owner}`).emit("reel:campaign-paused", {
      campaignId,
      status: "paused",
    });
  }

  res.json({ success: true, campaign });
}

export async function resumeCampaign(req, res) {
  const campaignId = req.params.id;
  const owner = req.user?._id;

  const campaign = await ReelCampaign.findOne({
    _id: campaignId,
    owner,
  });

  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  if (campaign.status !== "paused") {
    return res.status(400).json({ error: "Campaign is not paused" });
  }

  // Restore to previous status or set to running
  campaign.status = campaign.previousStatus || "running";
  delete campaign.previousStatus;
  await campaign.save();

  console.log(`[▶️  RESUME] Campaign resumed: ${campaignId}`);

  // Emit resume event
  if (io) {
    io.to(`user:${owner}`).emit("reel:campaign-resumed", {
      campaignId,
      status: campaign.status,
    });
  }

  res.json({ success: true, campaign });
}

export async function triggerUploadCheck(req, res) {
  try {
    console.log("[🔧 DEBUG] Manually triggering upload check...");

    const now = new Date();
    const pendingReels = await Reel.find({
      status: "pending",
      scheduledFor: { $lte: now },
    }).populate("campaign");

    console.log(
      `[🔧 DEBUG] Found ${pendingReels.length} reels ready for upload`,
    );

    res.json({
      success: true,
      message: `Found ${pendingReels.length} reels ready for upload`,
      reels: pendingReels.map((r) => ({
        _id: r._id,
        index: r.index,
        campaignTitle: r.campaign?.campaignTitle,
        status: r.status,
        scheduledFor: r.scheduledFor,
      })),
    });
  } catch (err) {
    console.error(`[❌ DEBUG] Error:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Check failed" });
  }
}

export async function debugTokenStatus(req, res) {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    console.log(
      `[🔧 DEBUG] Checking Instagram token status for user: ${userId}`,
    );

    try {
      const creds = await getInstagramCredentials(userId);
      const now = new Date();

      // Try to get session details
      const InstagramSession =
        await import("../instagram/models/InstagramSession.js").then(
          (m) => m.default,
        );
      const session = await InstagramSession.findOne({ userId });

      return res.json({
        success: true,
        credentials: {
          method: creds.method,
          igUserId: creds.igUserId,
          tokenPrefix: creds.accessToken?.substring(0, 20) + "...",
        },
        session: session
          ? {
              status: session.status,
              instagramUsername: session.graph?.instagramUsername,
              expiresAt: session.graph?.facebookUserAccessTokenExpiresAt,
              expiresIn: session.graph?.facebookUserAccessTokenExpiresAt
                ? Math.floor(
                    (new Date(session.graph.facebookUserAccessTokenExpiresAt) -
                      now) /
                      1000 /
                      3600,
                  ) + " hours"
                : "Unknown",
              scopes: session.graph?.scopes,
              lastRefreshed: session.graph?.lastRefreshed,
            }
          : null,
        debug: {
          now: now.toISOString(),
          userId: userId.toString(),
        },
      });
    } catch (credError) {
      return res.json({
        success: false,
        error: credError.message,
        debug: {
          userId: userId.toString(),
          message:
            "Failed to retrieve credentials - Instagram may not be connected",
        },
      });
    }
  } catch (err) {
    console.error(`[❌ DEBUG TOKEN] Error:`, err?.message || err);
    res.status(500).json({ error: err?.message || "Token check failed" });
  }
}
