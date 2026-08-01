/**
 * ============================================================================
 * SOCKET.IO SERVER ENHANCEMENTS
 * ============================================================================
 *
 * Add this to your server.js file to enable real-time session sync
 *
 * Location: After the io.on("connection") handler
 *
 */

// ============================================================================
// ENHANCED SOCKET.IO HANDLER WITH HEARTBEAT
// ============================================================================

// Add authentication middleware
io.use((socket, next) => {
  const token = socket.handshake.query.token;
  if (!token) {
    console.warn("Socket connection attempt without token");
    // Don't reject - allow unauthenticated for now, but could validate JWT
  }
  socket.token = token;
  next();
});

// Main connection handler
io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // NEW: User registration for real-time updates
  // Frontend should emit this immediately after socket connects
  socket.on("register:user", (data) => {
    if (data.userId) {
      socket.join(`user:${data.userId}`);
      console.log(`✅ Socket ${socket.id} registered for user:${data.userId}`);

      // Acknowledge registration
      socket.emit("user:registered", {
        userId: data.userId,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Session subscription (QR modal and polling)
  socket.on("join:session", (data) => {
    if (data.sessionId) {
      socket.join(data.sessionId);
      console.log(`✅ Socket ${socket.id} joined session:${data.sessionId}`);

      // Re-send pending QR to this socket (handles late joiners)
      const pendingQR = WhatsAppService.getPendingQR(data.sessionId);
      if (pendingQR) {
        socket.emit("qrcode", { sessionId: data.sessionId, qr: pendingQR });
        socket.emit("status", { sessionId: data.sessionId, status: "qr" });
      }
    }
  });

  socket.on("disconnect", () => {
    console.log("🔌 Client disconnected:", socket.id);
  });

  socket.on("error", (err) => {
    console.error("Socket error:", err.message);
  });

  // Heartbeat ping for connection keepalive
  socket.on("ping", () => {
    socket.emit("pong", { timestamp: new Date().toISOString() });
  });
});

// ============================================================================
// SESSION HEARTBEAT MONITOR (30s interval)
// ============================================================================

function startSessionHeartbeat() {
  console.log("🫀 Starting session heartbeat monitor (every 30s)");

  setInterval(async () => {
    try {
      // Find all sessions that should be connected or connecting
      const sessions = await mongoose.model("WhatsAppSession").find({
        status: { $in: ["connecting", "connected"] },
      });

      for (const session of sessions) {
        try {
          const sock = WhatsAppService.getSocket(session.sessionId);

          if (sock?.user?.id) {
            // Socket exists and has user - truly connected
            if (session.status !== "connected") {
              const phone = (sock.user.id || "").split("@")[0].split(":")[0];
              console.log(
                `[${session.sessionId}] 🔄 Heartbeat: DB stale, syncing...`,
              );

              // Update DB
              await mongoose.model("WhatsAppSession").updateOne(
                { sessionId: session.sessionId },
                {
                  status: "connected",
                  phoneNumber: phone,
                  lastConnected: new Date(),
                },
              );

              // Notify all clients
              const userId = session.userId.toString();
              io.to(`user:${userId}`).emit("session:update", {
                sessionId: session.sessionId,
                status: "connected",
                phoneNumber: phone,
                lastConnected: new Date(),
                lastUpdated: new Date().toISOString(),
              });
            }
          } else if (!sock) {
            // Socket missing but DB says connected/connecting
            const credsPath = require("path").join(
              __dirname,
              "..",
              "sessions",
              session.sessionId,
              "creds.json",
            );
            if (require("fs").existsSync(credsPath)) {
              console.log(
                `[${session.sessionId}] 🔄 Heartbeat: Stale session, reconnecting...`,
              );

              // Update DB to connecting
              await mongoose
                .model("WhatsAppSession")
                .updateOne(
                  { sessionId: session.sessionId },
                  { status: "connecting", lastConnected: new Date() },
                );

              // Notify clients
              const userId = session.userId.toString();
              io.to(`user:${userId}`).emit("session:update", {
                sessionId: session.sessionId,
                status: "connecting",
                lastConnected: new Date(),
                lastUpdated: new Date().toISOString(),
              });

              // Trigger reconnection
              WhatsAppService.reconnectSession(session.sessionId).catch(
                (err) => {
                  console.error(
                    `[${session.sessionId}] Heartbeat reconnect failed:`,
                    err.message,
                  );
                },
              );
            }
          }
        } catch (err) {
          console.error(
            `Heartbeat check failed for ${session.sessionId}:`,
            err.message,
          );
        }
      }
    } catch (err) {
      console.error("Heartbeat error:", err.message);
    }
  }, 30_000); // Run every 30 seconds
}

// ============================================================================
// INITIALIZATION IN START FUNCTION
// ============================================================================

/*
Update your start() function to include:

  const start = async () => {
    try {
      console.log("Connecting to MongoDB...");
      await mongoose.connect(MONGODB_URI);
      console.log("MongoDB connected");

      console.log("Bootstrapping subscription defaults...");
      await SubscriptionService.bootstrapDefaults();

      console.log("Restoring WhatsApp sessions...");
      await WhatsAppService.restoreSessions();

      // NEW: Start heartbeat AFTER restoring sessions
      startSessionHeartbeat();

      // ... rest of startup code ...

      httpServer.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
      });
    } catch (err) {
      console.error("Failed to start server:", err);
      process.exit(1);
    }
  };
*/

console.log("✅ Server Socket.io enhancements - add these to your server.js");
