import path from "path";
import fs from "fs";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";

const downloadsDir = path.join(process.cwd(), "uploads", "reel-temp");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

function cleanYouTubeUrl(url) {
  try {
    const parsed = new URL(url);
    const videoId = parsed.searchParams.get("v");

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
    return url;
  } catch (error) {
    return url;
  }
}

function isYouTubeUrl(url) {
  return /youtube\.com|youtu\.be/i.test(url || "");
}

function isPinterestUrl(url) {
  return /pinimg\.com|pinterest\.com/i.test(url || "");
}

function normalizePinterestVideoUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/pinimg\.com/i.test(parsed.hostname)) {
      return url;
    }

    const parts = parsed.pathname.split("/").filter(Boolean);
    const videosIndex = parts.indexOf("videos");

    if (videosIndex !== -1) {
      if (parts[videosIndex + 1]) {
        parts[videosIndex + 1] = "mc";
      }

      const hlsIndex = parts.indexOf("hls");
      if (hlsIndex !== -1) {
        parts[hlsIndex] = "720p";
      }

      parsed.pathname = `/${parts.join("/")}`;
    }

    return parsed.toString().replace(/\.m3u8(\?.*)?$/i, ".mp4$1");
  } catch (error) {
    return url;
  }
}

async function downloadWithFetch(url, outPath) {
  const response = await fetch(url, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while downloading remote video`);
  }

  await new Promise((resolve, reject) => {
    const fileStream = fs.createWriteStream(outPath);
    response.body.pipe(fileStream);
    response.body.on("error", reject);
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
  });
}

async function downloadHlsToMp4(url, outPath) {
  await new Promise((resolve, reject) => {
    ffmpeg(url)
      .videoCodec("libx264")
      .audioCodec("aac")
      .format("mp4")
      .outputOptions([
        "-preset fast",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
      ])
      .on("start", (cmd) => console.log(`[ffmpeg] start: ${cmd}`))
      .on("progress", (progress) =>
        console.log(`[ffmpeg] progress: ${JSON.stringify(progress)}`),
      )
      .on("end", resolve)
      .on("error", reject)
      .save(outPath);
  });
}

async function needsRecode(file) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(file, (error, metadata) => {
      if (error || !metadata) return resolve(true);

      const video = (metadata.streams || []).find(
        (stream) => stream.codec_type === "video",
      );
      const audio = (metadata.streams || []).find(
        (stream) => stream.codec_type === "audio",
      );

      if (!video || !audio) return resolve(true);

      const vcodec = (video.codec_name || "").toLowerCase();
      const acodec = (audio.codec_name || "").toLowerCase();
      const pixFmt = (video.pix_fmt || "").toLowerCase();
      const containerOk = path.extname(file).toLowerCase() === ".mp4";

      const videoOk = vcodec.includes("h264") || vcodec.includes("avc1");
      const audioOk = acodec.includes("aac") || acodec.includes("mp4a");
      const pixOk = pixFmt === "yuv420p" || pixFmt === "yuv420p10le";

      resolve(!(videoOk && audioOk && pixOk && containerOk));
    });
  });
}

async function maybeRecodeToH264(outPath) {
  const recodeNeeded = await needsRecode(outPath);
  if (!recodeNeeded) {
    console.log(
      "[🔁 TRANSCODE] No conversion needed — file already compatible",
    );
    return outPath;
  }

  const recodedPath = outPath.replace(/\.mp4$/i, "_h264.mp4");
  console.log(`[🔁 TRANSCODE] Converting to H.264+AAC: ${recodedPath}`);

  await new Promise((resolve, reject) => {
    ffmpeg(outPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .format("mp4")
      .outputOptions([
        "-preset fast",
        "-movflags +faststart",
        "-pix_fmt yuv420p",
      ])
      .on("start", (cmd) => console.log(`[ffmpeg] start: ${cmd}`))
      .on("progress", (progress) =>
        console.log(`[ffmpeg] progress: ${JSON.stringify(progress)}`),
      )
      .on("end", () => {
        try {
          fs.renameSync(recodedPath, outPath);
        } catch (error) {
          try {
            fs.copyFileSync(recodedPath, outPath);
            fs.unlinkSync(recodedPath);
          } catch (copyError) {
            console.warn(
              "[🔁 TRANSCODE] Failed to replace file:",
              copyError?.message || copyError,
            );
          }
        }
        resolve();
      })
      .on("error", reject)
      .save(recodedPath);
  });

  return outPath;
}

// Video downloading is intentionally disabled. Consumers should provide a
// local file path or a remote direct MP4 URL (e.g., Pinterest MP4) instead.
// This stub ensures code that imports `downloadVideoFromSource` will fail
// fast and clearly when attempting to download via the server.
async function downloadVideoFromSource(
  _url,
  _filenameHint = "video",
  _onProgress = null,
) {
  throw new Error(
    "Server-side video downloading has been disabled. Provide a local file path or remote MP4 URL instead.",
  );
}

export {
  downloadVideoFromSource,
  normalizePinterestVideoUrl,
};
