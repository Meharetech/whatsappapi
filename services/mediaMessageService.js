import crypto from "crypto";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";
import { tmpdir } from "os";
import { Message } from "../models/index.js";
import WhatsAppService from "./WhatsAppService.js";
import CampaignService from "./CampaignService.js";
import SubscriptionService from "./SubscriptionService.js";

const TYPE_TO_MIME = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/mpeg",
  document: "application/pdf",
};

const EXT_TO_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function normalizePhoneNumber(phoneNumber) {
  if (String(phoneNumber).includes("@")) {
    return String(phoneNumber);
  }

  let digits = String(phoneNumber || "").replace(/\D/g, "");
  if (digits.length === 10) {
    digits = `91${digits}`;
  }

  return digits;
}

function inferMediaType(type, fileName = "", mimeType = "") {
  const normalizedType = String(type || "")
    .toLowerCase()
    .trim();
  if (TYPE_TO_MIME[normalizedType]) {
    return normalizedType;
  }

  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";

  const ext = extname(fileName || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".webm", ".mov"].includes(ext)) {
    return "video";
  }
  if ([".mp3", ".wav", ".ogg"].includes(ext)) {
    return "audio";
  }

  return "document";
}

function mimeFromFileName(fileName, fallbackMime = "") {
  const ext = extname(fileName || "").toLowerCase();
  return EXT_TO_MIME[ext] || fallbackMime || "application/octet-stream";
}

function guessFileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const name = basename(parsed.pathname);
    return name || "media";
  } catch {
    return "media";
  }
}

function extensionFromMime(mimeType, fallbackName = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return ".jpg";
  if (mime.startsWith("video/")) return ".mp4";
  if (mime.startsWith("audio/")) return ".mp3";
  if (mime === "application/pdf") return ".pdf";

  const fallbackExt = extname(fallbackName || "");
  return fallbackExt || "";
}

async function downloadRemoteMedia(url, type, preferredName = "") {
  const response = await fetch(url, { redirect: "follow" });

  if (!response.ok) {
    throw new Error(`Failed to download media from URL (${response.status})`);
  }

  const fileName = preferredName || guessFileNameFromUrl(url);
  const responseMime = (response.headers.get("content-type") || "")
    .split(";")
    .shift()
    .trim();
  const mimeType =
    responseMime || mimeFromFileName(fileName, TYPE_TO_MIME[type]);
  const fileExtension = extensionFromMime(mimeType, fileName);
  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFilePath = join(
    tmpdir(),
    `wa-media-${Date.now()}-${crypto.randomUUID()}${fileExtension}`,
  );

  writeFileSync(tempFilePath, buffer);

  return {
    filePath: tempFilePath,
    mimeType,
    fileName,
  };
}

class MediaMessageService {
  async sendMediaMessage({
    userId,
    sessionId,
    phoneNumber,
    type,
    message = "",
    contactName = "",
    media = null,
    file = null,
  }) {
    const session = await CampaignService.findUserSession(userId, sessionId);

    if (!session) {
      throw new Error("Session not found");
    }

    if (session.status !== "connected") {
      throw new Error("Session is not connected");
    }

    const normalizedType = String(type || "text")
      .toLowerCase()
      .trim();
    const mediaUrl = media?.url || null;
    const mediaCaption = String(media?.caption || message || "").trim();
    const mediaFileName = String(
      media?.filename || file?.originalname || "",
    ).trim();
    const hasMediaInput = Boolean(mediaUrl || file);
    const isTextMessage = normalizedType === "text";

    if (!phoneNumber) {
      throw new Error("to (or phoneNumber) is required");
    }

    if (!isTextMessage && !hasMediaInput) {
      throw new Error("media.url or file is required for media messages");
    }

    const jid = normalizePhoneNumber(phoneNumber);
    const effectiveMessage =
      mediaCaption || mediaFileName || `${normalizedType} message`;
    const msgDoc = new Message({
      sessionId: session._id,
      phoneNumber: jid,
      contactName,
      message: effectiveMessage,
      messageType: "single",
      status: "pending",
    });

    let tempFilePath = null;
    let tempFileShouldCleanup = false;
    let resolvedMimeType = null;
    let mediaName = mediaFileName || null;

    try {
      await SubscriptionService.assertMessageQuota({ _id: userId }, 1);

      if (isTextMessage) {
        if (!message.trim()) {
          throw new Error("message is required for text messages");
        }

        await WhatsAppService.sendMessage(
          session.sessionId,
          jid,
          message.trim(),
        );
      } else if (file) {
        tempFilePath = file.path;
        tempFileShouldCleanup = Boolean(
          tempFilePath && existsSync(tempFilePath),
        );
        resolvedMimeType = file.mimetype;
        mediaName = file.originalname || mediaName;

        await WhatsAppService.sendMessage(
          session.sessionId,
          jid,
          effectiveMessage,
          tempFilePath,
          resolvedMimeType,
        );
      } else {
        const downloaded = await downloadRemoteMedia(
          mediaUrl,
          inferMediaType(normalizedType, mediaFileName),
          mediaFileName,
        );

        tempFilePath = downloaded.filePath;
        tempFileShouldCleanup = true;
        resolvedMimeType = downloaded.mimeType;
        mediaName = downloaded.fileName || mediaName;

        await WhatsAppService.sendMessage(
          session.sessionId,
          jid,
          effectiveMessage,
          tempFilePath,
          resolvedMimeType,
        );
      }

      await SubscriptionService.consumeMessageQuota(userId, 1);

      msgDoc.status = "sent";
      msgDoc.sentAt = new Date();
      await msgDoc.save();

      return {
        success: true,
        messageId: `msg_${msgDoc._id}`,
        to: jid,
        status: "sent",
        type: isTextMessage ? "text" : normalizedType,
        media: isTextMessage
          ? null
          : {
              source: file ? "upload" : "url",
              name: mediaName,
              url: mediaUrl || null,
              mimeType: resolvedMimeType,
            },
        timestamp: msgDoc.sentAt.toISOString(),
      };
    } catch (err) {
      msgDoc.status = "failed";
      msgDoc.error = err.message;
      await msgDoc.save();

      throw err;
    } finally {
      if (tempFileShouldCleanup && tempFilePath && existsSync(tempFilePath)) {
        try {
          unlinkSync(tempFilePath);
        } catch {
          // Ignore cleanup failures.
        }
      }
    }
  }
}

export default new MediaMessageService();
