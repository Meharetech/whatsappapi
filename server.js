import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import mongoose from "mongoose";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

import authRoutes from "./routes/auth.js";
import sessionRoutes from "./routes/sessions.js";
import messageRoutes from "./routes/messages.js";
import mediaMessageRoutes from "./routes/mediaMessages.js";
import campaignRoutes from "./routes/campaigns.js";
import numberListRoutes from "./routes/numberLists.js";
import mediaRoutes from "./routes/media.js";
import apiKeyRoutes from "./routes/apiKeys.js";
import subscriptionRoutes from "./routes/subscriptions.js";
import paymentRoutes from "./routes/payments.js";
import analyticsRoutes from "./routes/analytics.js";
import settingsRoutes from "./routes/settings.js";
import adminRoutes from "./routes/admin.js";
import chatRoutes from "./routes/chats.js";
import aiAgentRoutes from "./routes/aiAgent.js";
import flowRoutes from "./routes/flows.js";
import metaRoutes from "./meta/routes/index.js";
import instagramRoutes from "./instagram/routes/instagram.js";
import instagramAiAgentRoutes from "./instagram/routes/instagram-ai-agent.js";
import webhookRoutes from "./routes/webhook.js";
import googleReviewRoutes from "./google-review/routes/google-review.js";
import pinterestRoutes from "./routes/pinterest.js";
import reelRoutes from "./routes/reelCampaigns.js";
import groupBroadcastRoutes from "./routes/groupBroadcast.js";
import { setSocketIO as setReelSocketIO } from "./controllers/reelCampaignController.js";
import { startUploadScheduler } from "./services/reels/uploadScheduler.js";
import WhatsAppService from "./services/WhatsAppService.js";
import CampaignService from "./services/CampaignService.js";
import SubscriptionService from "./services/SubscriptionService.js";
import Campaign from "./models/Campaign.js";
import OpenRouterSettings from "./models/OpenRouterSettings.js";
import { startCampaignById } from "./controllers/campaignController.js";


const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    credentials: true,
  },
});

WhatsAppService.setSocketIO(io);
CampaignService.setSocketIO(io);
setReelSocketIO(io);

const corsOptions = {
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept", "Origin"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("WhatsApp API is running v2.0.1 by ME");
});

// Serve uploaded files
app.use("/uploads", express.static("uploads"));

app.use("/api/auth", authRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/messages/media", mediaMessageRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/number-lists", numberListRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/api-keys", apiKeyRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/chats", chatRoutes);
app.use("/api/ai-agent", aiAgentRoutes);
app.use("/api/flows", flowRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/instagram", instagramRoutes);
app.use("/api/instagram/ai-agent", instagramAiAgentRoutes);
app.use("/api/webhook", webhookRoutes);
app.use("/api/google-review", googleReviewRoutes);
app.use("/api/pinterest", pinterestRoutes);
app.use("/api/reels", reelRoutes);
app.use("/api/group-broadcast", groupBroadcastRoutes);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("join:user", (data) => {
    if (data.userId) {
      socket.join(`user:${data.userId}`);
      console.log(`Socket ${socket.id} joined user room: user:${data.userId}`);
    }
  });

  socket.on("join:session", (data) => {
    if (data.sessionId) {
      socket.join(data.sessionId);
      console.log(`Socket ${socket.id} joined room ${data.sessionId}`);

      // Re-send pending QR to this socket (fixes race condition where QR
      // was emitted before frontend joined the room)
      const pendingQR = WhatsAppService.getPendingQR(data.sessionId);
      if (pendingQR) {
        socket.emit("qrcode", { sessionId: data.sessionId, qr: pendingQR });
        socket.emit("status", { sessionId: data.sessionId, status: "qr" });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);
  });
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://admin:admin@cmr0.3uulrrh.mongodb.net";

const start = async () => {
  try {
    // ✅ 1. START SERVER FIRST (VERY IMPORTANT)
    httpServer.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });

    // ✅ 2. CONNECT MONGODB (NON-BLOCKING)
    console.log("Connecting to MongoDB...");
    mongoose;
    mongoose
      .connect(MONGODB_URI)
      .then(async () => {
        console.log("✅ MongoDB connected");

        // Seed OpenRouter global settings from env key
        if (process.env.OPENROUTER_API_KEY) {
          await OpenRouterSettings.findOneAndUpdate(
            { key: "global" },
            {
              $setOnInsert: { key: "global", provider: "openrouter", model: "openai/gpt-4o-mini" },
              $set: { apiKey: process.env.OPENROUTER_API_KEY.trim() }
            },
            { upsert: true, new: true }
          )
          .then((settings) => console.log(`[🔑 AI AGENT] Seeded OpenRouter API key successfully (model: ${settings.model})`))
          .catch((e) => console.error("OpenRouter seed error:", e.message));
        }

        await WhatsAppService.restoreSessions().catch((err) =>
          console.error("WA restore error:", err.message),
        );
      })
      .catch((err) => console.error("❌ MongoDB error:", err.message));

    // ✅ 3. BOOTSTRAP (NON-BLOCKING)
    SubscriptionService.bootstrapDefaults().catch((err) =>
      console.error("Bootstrap error:", err.message),
    );

    // ✅ 4. START REEL UPLOAD SCHEDULER
    startUploadScheduler(io);

    // ✅ 5. SCHEDULER (SAFE)
    // const runScheduler = async () => {
    //   try {
    //     const due = await Campaign.find({
    //       status: "scheduled",
    //       scheduledFor: { $lte: new Date() },
    //     });

    //     for (const c of due) {
    //       await startCampaignById(c._id);
    //     }
    //   } catch (err) {
    //     console.error("[SCHEDULER] Error:", err.message);
    //   }
    // };

    // run after slight delay (DB ready hone ke liye)
    // setTimeout(() => {
    //   runScheduler();
    //   setInterval(runScheduler, 60_000);
    // }, 5000);
  } catch (err) {
    console.error("Startup error:", err);
  }
};

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err.message);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err.message);
  process.exit(1);
});

start();
