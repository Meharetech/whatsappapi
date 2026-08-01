/**
 * REAL-TIME SYNC ARCHITECTURE ENHANCEMENTS
 * =========================================
 * 
 * This document outlines the critical enhancements needed for:
 * 1. Event-driven session state synchronization
 * 2. Heartbeat-based stale detection
 * 3. Socket.io room management improvements
 * 4. Reliable reconnection handling
 * 
 * ISSUE: Frontend shows "connected" while WhatsApp is actually offline
 * 
 * ROOT CAUSES:
 * ✗ Frontend never joins session rooms after QR modal closes
 * ✗ No heartbeat to detect stale sessions
 * ✗ Socket.io events emitted to empty rooms (no subscribers)
 * ✗ Session state cached in DB without real-time verification
 * 
 * SOLUTION ARCHITECTURE:
 * ======================
 * 
 * 1. WhatsAppService → Emit session:update to ALL user's sockets
 *    io.to(userId).emit("session:update", {...})  // NOT io.to(sessionId)
 *    
 * 2. Server → Heartbeat every 30s checking socket health
 *    Detect stale sessions and trigger reconnect
 *    
 * 3. Frontend → Subscribe to session:update in main Sessions page
 *    Listen on user channel, not session channel
 *    Implement 15s polling fallback
 *    
 * 4. Robust Reconnection → Track attempts, exponential backoff
 *    Server restart recovery via DB restoration
 */

// ============================================================================
// PART 1: WhatsAppService enhancements - Session Event Emission
// ============================================================================

/**
 * Add this method to WhatsAppService class:
 */

async emitSessionUpdate(sessionId, statusInfo) {
  if (!this.io) return;
  
  // Get session to find user
  const session = await SessionModel.findOne({ sessionId });
  if (!session) return;
  
  const userId = session.userId.toString();
  const timestamp = new Date().toISOString();
  
  const updatePayload = {
    sessionId,
    name: session.name,
    status: statusInfo.status || session.status,
    phoneNumber: statusInfo.phoneNumber || session.phoneNumber,
    lastConnected: statusInfo.lastConnected || session.lastConnected,
    lastUpdated: timestamp,
  };
  
  // CRITICAL: Emit to user room, NOT session room
  // This ensures ALL client instances for this user receive the update
  this.io.to(`user:${userId}`).emit("session:update", updatePayload);
  
  console.log(`[${sessionId}] Emitted session:update to user:${userId}`, {
    status: updatePayload.status,
    timestamp,
  });
}

/**
 * Update connection.update handler in createSocket():
 * 
 * Replace lines 133-242 with enhanced version that:
 * 1. Properly updates DB on state change
 * 2. Emits real-time updates
 * 3. Tracks state transitions
 */

async enhancedConnectionUpdateHandler(update, {
  sessionId, 
  authState, 
  sock, 
  isConnected,
  isLoggingOut,
  hasGeneratedQR,
}) {
  const { qr, connection } = update;
  
  console.log(`[${sessionId}] Connection update:`, {
    connection,
    hasQR: !!qr,
    timestamp: new Date().toISOString(),
  });

  // ──────────────────────────────────────────────────────────────────────
  // QR CODE HANDLER
  // ──────────────────────────────────────────────────────────────────────
  if (qr) {
    hasGeneratedQR = true;
    console.log(`[${sessionId}] QR RECEIVED at ${new Date().toISOString()}`);
    
    qrcode.toDataURL(qr, async (err, url) => {
      if (!err && url) {
        this.pendingQRCodes.set(sessionId, url);
        console.log(`[${sessionId}] QR cached, emitting to subscribers`);
        
        if (this.io) {
          this.io.to(sessionId).emit("qrcode", { sessionId, qr: url });
          this.io.to(sessionId).emit("status", { sessionId, status: "qr" });
        }
        
        // Update DB to "pending" state
        await SessionModel.updateOne(
          { sessionId },
          { status: "pending", lastConnected: new Date() },
        ).catch(console.error);
        
      } else if (err) {
        console.error(`[${sessionId}] QR generation error:`, err.message);
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // CONNECTION OPENED → AUTHENTICATED
  // ──────────────────────────────────────────────────────────────────────
  if (connection === "open") {
    console.log(`[${sessionId}] ✅ CONNECTED at ${new Date().toISOString()}`);
    isConnected = true;
    this.reconnectAttempts.delete(sessionId);
    this.pendingQRCodes.delete(sessionId);
    
    const phone = (sock.user?.id || "").split("@")[0].split(":")[0];
    const updateData = {
      status: "connected",
      phoneNumber: phone || "",
      lastConnected: new Date(),
    };
    
    // Update DB
    await SessionModel.updateOne({ sessionId }, updateData).catch(console.error);
    
    // Emit real-time update to ALL user's sockets
    await this.emitSessionUpdate(sessionId, updateData);
    
    // Also emit to QR modal (if still open)
    if (this.io) {
      this.io.to(sessionId).emit("status", {
        sessionId,
        status: "connected",
        phoneNumber: phone,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // CONNECTION CLOSED → HANDLE RECONNECTION LOGIC
  // ──────────────────────────────────────────────────────────────────────
  if (connection === "close") {
    if (isLoggingOut) {
      console.log(`[${sessionId}] Logged out intentionally`);
      return;
    }

    const reason =
      update.lastDisconnect?.error instanceof Boom
        ? update.lastDisconnect.error.output.statusCode
        : 0;

    const shouldReconnect = reason !== DisconnectReason.loggedOut;
    const isRestartRequired = reason === DisconnectReason.restartRequired;
    const isRegistered = !!authState.state.creds?.registered;
    const attempts = this.reconnectAttempts.get(sessionId) || 0;

    console.log(`[${sessionId}] ❌ DISCONNECTED (reason: ${reason}) at ${new Date().toISOString()}`);

    isConnected = false;

    // Logic: automatic reconnection with backoff
    if (isRestartRequired || (shouldReconnect && isRegistered)) {
      console.log(`[${sessionId}] Auto-reconnecting in 3s...`);
      await SessionModel.updateOne(
        { sessionId },
        { status: "connecting", lastConnected: new Date() },
      ).catch(console.error);
      
      await this.emitSessionUpdate(sessionId, { 
        status: "connecting",
        lastConnected: new Date(),
      });
      
      this.sockets.delete(sessionId);
      setTimeout(() => {
        this.reconnectSession(sessionId).catch(console.error);
      }, 3000);
    } 
    // ... (rest of reconnection logic with emitSessionUpdate calls)
    else if (!shouldReconnect) {
      console.log(`[${sessionId}] User logged out from WhatsApp`);
      await SessionModel.updateOne(
        { sessionId },
        { status: "disconnected", lastConnected: new Date() },
      ).catch(console.error);
      
      await this.emitSessionUpdate(sessionId, {
        status: "disconnected",
        lastConnected: new Date(),
      });
    } 
    else {
      // Unexpected close - attempt recovery
      const credsPath = join(SESSIONS_DIR, sessionId, "creds.json");
      if (existsSync(credsPath)) {
        console.log(`[${sessionId}] Attempting recovery reconnect in 15s`);
        await SessionModel.updateOne(
          { sessionId },
          { status: "connecting", lastConnected: new Date() },
        ).catch(console.error);
        
        await this.emitSessionUpdate(sessionId, {
          status: "connecting",
          lastConnected: new Date(),
        });
        
        setTimeout(() => {
          if (!this.sockets.has(sessionId)) {
            this.reconnectSession(sessionId).catch(console.error);
          }
        }, 15000);
      } else {
        await SessionModel.updateOne(
          { sessionId },
          { status: "disconnected", lastConnected: new Date() },
        ).catch(console.error);
        
        await this.emitSessionUpdate(sessionId, {
          status: "disconnected",
          lastConnected: new Date(),
        });
      }
    }
  }
}

// ============================================================================
// PART 2: Add Session Health Check (Heartbeat)
// ============================================================================

/**
 * Add to WhatsAppService:
 * Runs every 30 seconds to detect and fix stale sessions
 */

async startHeartbeat() {
  console.log("🫀 Starting session heartbeat (30s interval)");
  
  setInterval(async () => {
    try {
      const sessions = await SessionModel.find({
        status: { $in: ["connecting", "connected"] },
      });

      for (const session of sessions) {
        const sock = this.sockets.get(session.sessionId);
        
        // Socket exists and has user ID → truly connected
        if (sock?.user?.id) {
          if (session.status !== "connected") {
            console.log(`[${session.sessionId}] 🔄 Heartbeat: Syncing DB (socket live, DB stale)`);
            const phone = (sock.user.id || "").split("@")[0].split(":")[0];
            await SessionModel.updateOne(
              { sessionId: session.sessionId },
              { status: "connected", phoneNumber: phone },
            );
            await this.emitSessionUpdate(session.sessionId, {
              status: "connected",
              phoneNumber: phone,
            });
          }
        } 
        // Socket missing but DB says connected/connecting → trigger reconnect
        else {
          const credsPath = join(SESSIONS_DIR, session.sessionId, "creds.json");
          if (existsSync(credsPath)) {
            console.log(`[${session.sessionId}] 🔄 Heartbeat: Stale detected, reconnecting...`);
            await SessionModel.updateOne(
              { sessionId: session.sessionId },
              { status: "connecting" },
            );
            await this.emitSessionUpdate(session.sessionId, {
              status: "connecting",
            });
            
            this.reconnectSession(session.sessionId).catch(console.error);
          }
        }
      }
    } catch (err) {
      console.error("Heartbeat error:", err.message);
    }
  }, 30_000); // 30 seconds
}

// ============================================================================
// PART 3: Integration in server.js
// ============================================================================

/**
 * Update server.js socket.io handler:
 * 
 * BEFORE (lines 45-60):
 * 
 *   io.on("connection", (socket) => {
 *     console.log("Client connected:", socket.id);
 *     socket.on("join:session", (data) => {
 *       if (data.sessionId) socket.join(data.sessionId);
 *     });
 *   });
 * 
 * AFTER: Use this enhanced version
 */

// ENHANCED socket.io middleware
io.use((socket, next) => {
  const token = socket.handshake.query.token;
  if (!token) {
    return next(new Error("Authentication required"));
  }
  // Verify token here if needed
  socket.token = token;
  next();
});

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);

  // User joins their personal update channel
  // Extract user ID from token and join user-specific room
  socket.on("register:user", (data) => {
    if (data.userId) {
      socket.join(`user:${data.userId}`);
      console.log(`🔗 Socket ${socket.id} registered for user:${data.userId}`);
    }
  });

  // For backward compatibility: session-level subscription (QR modal)
  socket.on("join:session", (data) => {
    if (data.sessionId) {
      socket.join(data.sessionId);
      console.log(`🔗 Socket ${socket.id} joined session:${data.sessionId}`);

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
    console.error("Socket error:", err);
  });
});

// Start heartbeat after server starts
httpServer.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  WhatsAppService.startHeartbeat();
});

// ============================================================================
// PART 4: Frontend Integration in Sessions.jsx
// ============================================================================

/**
 * Update Sessions.jsx to:
 * 1. Register user on socket connection
 * 2. Listen for session:update events
 * 3. Implement polling fallback
 * 
 * See sessions-jsx-enhancements.js for full implementation
 */

console.log("✅ Real-time sync architecture enhancements ready for implementation");
