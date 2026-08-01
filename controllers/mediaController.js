import fs from "fs";
import MediaCollection from "../models/Media.js";
import MediaSettings from "../models/MediaSettings.js";
import { formatFilePath } from "../utils/fileUpload.js";
import SubscriptionService from "../services/SubscriptionService.js";
import { sendSubscriptionError } from "../utils/subscription.js";

// Create new collection
export const createCollection = async (req, res) => {
  try {
    const { name, colorId } = req.body;
    const userId = req.user.id;

    const collection = new MediaCollection({
      userId,
      id: `col${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      colorId: colorId || "blue",
      media: [],
      subcollections: [],
    });

    await collection.save();
    res.status(201).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get all collections for user
export const getCollections = async (req, res) => {
  try {
    const userId = req.user.id;
    const collections = await MediaCollection.find({ userId }).sort({
      createdAt: -1,
    });

    // Calculate analytics
    const allMedia = [];
    collections.forEach((col) => {
      (col.media || []).forEach((m) => allMedia.push(m));
      (col.subcollections || []).forEach((sc) => {
        (sc.media || []).forEach((m) => allMedia.push(m));
      });
    });

    const analytics = {
      totalCollections: collections.length,
      totalSubfolders: collections.reduce(
        (s, c) => s + (c.subcollections?.length || 0),
        0,
      ),
      totalFiles: allMedia.length,
      images: allMedia.filter((m) => m.type === "image").length,
      videos: allMedia.filter((m) => m.type === "video").length,
      pdfs: allMedia.filter((m) => m.type === "pdf").length,
      documents: allMedia.filter((m) => m.type === "document").length,
      audios: allMedia.filter((m) => m.type === "audio").length,
      totalSize: collections.reduce((s, c) => s + (c.totalSize || 0), 0),
    };

    res.status(200).json({ success: true, data: collections, analytics });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get single collection
export const getCollection = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Update collection
export const updateCollection = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, colorId } = req.body;
    const userId = req.user.id;

    const collection = await MediaCollection.findOneAndUpdate(
      { _id: id, userId },
      { name, colorId },
      { new: true },
    );

    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete collection
export const deleteCollection = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const collection = await MediaCollection.findOneAndDelete({
      _id: id,
      userId,
    });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    res.status(200).json({ success: true, message: "Collection deleted" });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Add subcollection
export const addSubcollection = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    const subcollection = {
      id: `sc${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      created: new Date(),
      media: [],
    };

    collection.subcollections.unshift(subcollection);
    await collection.save();

    res.status(201).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Rename subcollection
export const renameSubcollection = async (req, res) => {
  try {
    const { id, scId } = req.params;
    const { name } = req.body;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    const sc = collection.subcollections.find((s) => s.id === scId);
    if (!sc) {
      return res
        .status(404)
        .json({ success: false, error: "Subcollection not found" });
    }

    sc.name = name;
    await collection.save();

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete subcollection
export const deleteSubcollection = async (req, res) => {
  try {
    const { id, scId } = req.params;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    collection.subcollections = collection.subcollections.filter(
      (s) => s.id !== scId,
    );
    await collection.save();

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Upload media to collection
export const uploadToCollection = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file provided" });
    }

    await assertMediaSizeLimit(req.file);
    await SubscriptionService.assertStorageLimit(req.user, req.file.size || 0);

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    // Create media object with file info
    const mediaItem = {
      id: `m${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: req.file.originalname,
      type: getFileType(req.file.mimetype),
      size: formatBytes(req.file.size),
      created: new Date(),
      usedIn: 0,
      fileUrl: formatFilePath(req.file.filename),
      fileSize: req.file.size, // Store raw bytes for sorting/filtering
    };

    if (!collection.media) collection.media = [];
    collection.media.unshift(mediaItem);
    await collection.save();

    res.status(201).json({ success: true, data: collection });
  } catch (error) {
    if (error.statusCode === 413) {
      return res.status(413).json({ success: false, error: error.message });
    }
    return sendSubscriptionError(res, error, "Failed to upload media");
  }
};

// Upload media to subcollection
export const uploadToSubcollection = async (req, res) => {
  try {
    const { id, scId } = req.params;
    const userId = req.user.id;

    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file provided" });
    }

    await assertMediaSizeLimit(req.file);
    await SubscriptionService.assertStorageLimit(req.user, req.file.size || 0);

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    const sc = collection.subcollections.find((s) => s.id === scId);
    if (!sc) {
      return res
        .status(404)
        .json({ success: false, error: "Subcollection not found" });
    }

    // Create media object with file info
    const mediaItem = {
      id: `m${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: req.file.originalname,
      type: getFileType(req.file.mimetype),
      size: formatBytes(req.file.size),
      created: new Date(),
      usedIn: 0,
      fileUrl: formatFilePath(req.file.filename),
      fileSize: req.file.size,
    };

    if (!sc.media) sc.media = [];
    sc.media.unshift(mediaItem);
    await collection.save();

    res.status(201).json({ success: true, data: collection });
  } catch (error) {
    if (error.statusCode === 413) {
      return res.status(413).json({ success: false, error: error.message });
    }
    return sendSubscriptionError(res, error, "Failed to upload media");
  }
};

// Helper functions
function getFileType(mimetype) {
  if (mimetype.startsWith("image/")) return "image";
  if (mimetype.startsWith("video/")) return "video";
  if (mimetype.includes("pdf")) return "pdf";
  if (mimetype.includes("audio")) return "audio";
  if (mimetype.includes("word") || mimetype.includes("document"))
    return "document";
  return "document";
}

async function assertMediaSizeLimit(file) {
  const settings = await MediaSettings.findOne({ key: "global" });
  const type = getFileType(file.mimetype);
  // pdf/document both map to "document" limit
  const limitKey = type === "pdf" ? "document" : type;
  const maxMB = settings?.[limitKey]?.maxSizeMB ?? 25;
  if (file.size > maxMB * 1024 * 1024) {
    fs.unlinkSync(file.path);
    throw Object.assign(
      new Error(`${type.charAt(0).toUpperCase() + type.slice(1)} files must be under ${maxMB} MB`),
      { statusCode: 413 },
    );
  }
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// Delete media from collection
export const deleteMediaFromCollection = async (req, res) => {
  try {
    const { id, mediaId } = req.params;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    collection.media = (collection.media || []).filter((m) => m.id !== mediaId);
    await collection.save();

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete media from subcollection
export const deleteMediaFromSubcollection = async (req, res) => {
  try {
    const { id, scId, mediaId } = req.params;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    const sc = collection.subcollections.find((s) => s.id === scId);
    if (!sc) {
      return res
        .status(404)
        .json({ success: false, error: "Subcollection not found" });
    }

    sc.media = (sc.media || []).filter((m) => m.id !== mediaId);
    await collection.save();

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Delete multiple media items
export const deleteMultipleMedia = async (req, res) => {
  try {
    const { id, scId, mediaIds } = req.body;
    const userId = req.user.id;

    const collection = await MediaCollection.findOne({ _id: id, userId });
    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    if (scId) {
      const sc = collection.subcollections.find((s) => s.id === scId);
      if (sc) {
        sc.media = (sc.media || []).filter((m) => !mediaIds.includes(m.id));
      }
    } else {
      collection.media = (collection.media || []).filter(
        (m) => !mediaIds.includes(m.id),
      );
    }

    await collection.save();
    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Rename collection
export const renameCollection = async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    const userId = req.user.id;

    const collection = await MediaCollection.findOneAndUpdate(
      { _id: id, userId },
      { name },
      { new: true },
    );

    if (!collection) {
      return res
        .status(404)
        .json({ success: false, error: "Collection not found" });
    }

    res.status(200).json({ success: true, data: collection });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};
