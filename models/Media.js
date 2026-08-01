import mongoose from "mongoose";

const mediaItemSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  type: {
    type: String,
    enum: ["image", "pdf", "video", "document", "audio"],
    required: true,
  },
  size: { type: String, required: true },
  created: { type: Date, default: Date.now },
  usedIn: { type: Number, default: 0 },
  fileUrl: { type: String }, // URL to stored file
  fileSize: { type: Number, default: 0 },
});

const subcollectionSchema = new mongoose.Schema({
  id: { type: String, required: true },
  name: { type: String, required: true },
  created: { type: Date, default: Date.now },
  media: [mediaItemSchema],
});

const collectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    id: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    colorId: {
      type: String,
      enum: ["blue", "emerald", "violet", "amber", "rose", "cyan"],
      default: "blue",
    },
    created: { type: Date, default: Date.now },
    media: [mediaItemSchema],
    subcollections: [subcollectionSchema],
    totalSize: { type: Number, default: 0 }, // Total bytes
  },
  {
    timestamps: true,
  },
);

// Index for user queries
collectionSchema.index({ userId: 1, createdAt: -1 });

// Calculate total size before save
collectionSchema.pre("save", function (next) {
  const parseBytes = (sizeStr) => {
    const m = (sizeStr || "").match(/^([\d.]+)\s*(KB|MB|GB)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return u === "GB" ? v * 1073741824 : u === "MB" ? v * 1048576 : v * 1024;
  };

  const getItemBytes = (item) => {
    if (Number(item?.fileSize) > 0) return Number(item.fileSize);
    return parseBytes(item?.size);
  };

  let total = 0;
  (this.media || []).forEach((m) => (total += getItemBytes(m)));
  (this.subcollections || []).forEach((sc) => {
    (sc.media || []).forEach((m) => (total += getItemBytes(m)));
  });
  this.totalSize = total;
  next();
});

export default mongoose.model("MediaCollection", collectionSchema);
