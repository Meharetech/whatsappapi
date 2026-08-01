import path from "path";
import fs from "fs";
import { spawn } from "child_process";

const clipsDir = path.join(process.cwd(), "uploads", "reel-clips");
if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

export function splitVideoToClips(inputPath, clipLengthSec, onProgress = null) {
  return new Promise((resolve, reject) => {
    console.log(`[✂️ SPLIT] Starting video split: ${inputPath}`);
    console.log(`[✂️ SPLIT] Clip length: ${clipLengthSec} seconds`);

    // Determine duration using ffprobe
    const ffprobe = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);

    let durationOutput = "";
    ffprobe.stdout.on("data", (d) => (durationOutput += d.toString()));
    ffprobe.on("close", (code) => {
      const duration = parseFloat(durationOutput) || 0;
      const parts = Math.ceil(duration / clipLengthSec);
      console.log(
        `[✂️ SPLIT] Video duration: ${duration.toFixed(2)}s → ${parts} clips`,
      );

      const outputs = [];

      let completed = 0;
      for (let i = 0; i < parts; i++) {
        const start = i * clipLengthSec;
        const out = path.join(
          clipsDir,
          `${path.basename(inputPath, path.extname(inputPath))}_part_${i + 1}.mp4`,
        );
        outputs.push(out);

        console.log(`[✂️ SPLIT] Creating clip ${i + 1}/${parts}: ${out}`);
        if (onProgress)
          onProgress({ stage: "splitting", current: i + 1, total: parts });

        const args = [
          "-y",
          "-ss",
          `${start}`,
          "-i",
          inputPath,
          "-t",
          `${clipLengthSec}`,
          "-c",
          "copy",
          out,
        ];
        const ffmpeg = spawn("ffmpeg", args);
        ffmpeg.on("close", (c) => {
          completed++;
          console.log(`[✂️ SPLIT] Clip ${completed}/${parts} complete`);
          if (onProgress)
            onProgress({
              stage: "splitting",
              current: completed,
              total: parts,
            });
          if (completed === parts) {
            console.log(`[✅ SPLIT] All clips created!`);
            resolve(outputs);
          }
        });
        ffmpeg.on("error", (err) => {
          console.error(`[❌ SPLIT] Error creating clip: ${err.message}`);
          reject(err);
        });
      }
    });

    ffprobe.on("error", (err) => {
      console.error(`[❌ SPLIT] FFprobe error: ${err.message}`);
      reject(err);
    });
  });
}
