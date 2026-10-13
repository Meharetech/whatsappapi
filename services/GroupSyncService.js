import WhatsAppGroup from "../models/WhatsAppGroup.js";
import WhatsAppSession from "../models/WhatsAppSession.js";

// Helper to resolve LIDs for group participants
async function resolveParticipantsLids(sock, participants) {
  if (!participants || !Array.isArray(participants) || !sock) return;

  const lidsToResolve = [...new Set(
    participants
      .filter((p) => p.id && p.id.endsWith("@lid") && !p.phoneNumber)
      .map((p) => p.id)
  )];

  if (lidsToResolve.length === 0) return;

  const resolvedMappings = {};
  const BATCH_SIZE = 25;

  for (let i = 0; i < lidsToResolve.length; i += BATCH_SIZE) {
    const chunk = lidsToResolve.slice(i, i + BATCH_SIZE);
    await Promise.all(
      chunk.map(async (lid) => {
        try {
          const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID(lid);
          if (pnJid) {
            resolvedMappings[lid] = pnJid;
          }
        } catch (_) {}
      })
    );
    if (i + BATCH_SIZE < lidsToResolve.length) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  for (const p of participants) {
    if (p.id && resolvedMappings[p.id]) {
      p.phoneNumber = resolvedMappings[p.id];
    }
  }
}

class GroupSyncService {
  /**
   * Sync all participating groups from WhatsApp into MongoDB.
   * Runs once on session connect or on user-demanded manual refresh.
   */
  async syncSessionGroups(sessionId, sock, io, options = {}) {
    if (!sessionId || !sock) {
      throw new Error("Missing sessionId or socket for group sync");
    }

    const session = await WhatsAppSession.findOne({ sessionId });
    if (!session) {
      throw new Error(`Session ${sessionId} not found in database`);
    }

    try {
      // Mark session as syncing in background
      await WhatsAppSession.updateOne(
        { sessionId },
        { $set: { groupSyncStatus: "syncing" } }
      );

      console.log(`[GROUP SYNC] Starting full group sync for session ${sessionId}...`);

      // 1. Fetch participating groups from live Baileys socket
      const rawGroups = await sock.groupFetchAllParticipating();
      const groupsArray = Object.values(rawGroups || {});

      console.log(`[GROUP SYNC] Discovered ${groupsArray.length} groups on WhatsApp for session ${sessionId}`);

      // 2. Resolve LIDs across all participants
      const allParticipants = groupsArray.flatMap((g) => g.participants || []);
      await resolveParticipantsLids(sock, allParticipants);

      const myJidClean = sock.user?.id?.split(":")[0]?.split("@")[0];

      // 3. Prepare bulk operations for MongoDB
      const now = new Date();
      const activeJids = [];

      const bulkOps = groupsArray.map((g) => {
        activeJids.push(g.id);
        const isAdminOnly = g.announce === true || g.announce === "true";
        let isMeAdmin = false;

        if (g.participants && Array.isArray(g.participants) && myJidClean) {
          const me = g.participants.find((p) => {
            const pIdClean = p.id?.split(":")[0]?.split("@")[0];
            return pIdClean === myJidClean;
          });
          if (me && (me.admin === "admin" || me.admin === "superadmin")) {
            isMeAdmin = true;
          }
        }

        const canSend = !isAdminOnly || isMeAdmin;

        const formattedParticipants = (g.participants || []).map((p) => {
          let pNum = p.phoneNumber || "";
          if (!pNum && p.id?.endsWith("@s.whatsapp.net")) {
            pNum = p.id.split("@")[0].split(":")[0];
          }
          return {
            id: p.id,
            admin: p.admin || null,
            phoneNumber: pNum,
            lid: p.id?.endsWith("@lid") ? p.id : null,
          };
        });

        return {
          updateOne: {
            filter: { sessionId, jid: g.id },
            update: {
              $set: {
                userId: session.userId,
                sessionId,
                jid: g.id,
                subject: g.subject || "WhatsApp Group",
                description: typeof g.desc === "string" ? g.desc : "",
                owner: g.owner || null,
                creation: g.creation || null,
                participants: formattedParticipants,
                participantCount: formattedParticipants.length,
                announce: isAdminOnly,
                restrict: g.restrict === true || g.restrict === "true",
                size: g.size || formattedParticipants.length,
                canSend,
                isMeAdmin,
                lastSyncedAt: now,
              },
            },
            upsert: true,
          },
        };
      });

      // 4. Bulk write to MongoDB in 1 fast operation
      if (bulkOps.length > 0) {
        await WhatsAppGroup.bulkWrite(bulkOps, { ordered: false });
      }

      // 5. If prune option is set or during full sync, remove groups user is no longer in
      if (options.prune !== false && activeJids.length > 0) {
        await WhatsAppGroup.deleteMany({
          sessionId,
          jid: { $nin: activeJids },
        });
      }

      // 6. Update session metadata
      await WhatsAppSession.updateOne(
        { sessionId },
        {
          $set: {
            groupSyncStatus: "completed",
            groupsCount: groupsArray.length,
            lastGroupSyncAt: now,
          },
        }
      );

      console.log(`[GROUP SYNC] Successfully synchronized ${groupsArray.length} groups to MongoDB for session ${sessionId}`);

      // 7. Emit WebSocket event to client
      if (io) {
        const payload = {
          sessionId,
          count: groupsArray.length,
          lastSyncedAt: now,
        };
        io.to(sessionId).emit("groups:synced", payload);
        if (session.userId) {
          io.to(`user:${session.userId.toString()}`).emit("groups:synced", payload);
        }
      }

      return { success: true, count: groupsArray.length };
    } catch (err) {
      console.error(`[GROUP SYNC] Error syncing groups for session ${sessionId}:`, err.message);
      await WhatsAppSession.updateOne(
        { sessionId },
        { $set: { groupSyncStatus: "failed" } }
      ).catch(() => {});
      throw err;
    }
  }

  /**
   * Handle Baileys 'groups.upsert' event (e.g. account joins or discovers new groups).
   * Updates only those specific groups in MongoDB without full fetch.
   */
  async handleGroupsUpsert(sessionId, groups, sock, io) {
    if (!Array.isArray(groups) || groups.length === 0) return;

    try {
      const session = await WhatsAppSession.findOne({ sessionId });
      if (!session) return;

      const myJidClean = sock?.user?.id?.split(":")[0]?.split("@")[0];
      const allParticipants = groups.flatMap((g) => g.participants || []);
      if (sock) {
        await resolveParticipantsLids(sock, allParticipants);
      }

      const bulkOps = groups.map((g) => {
        const isAdminOnly = g.announce === true || g.announce === "true";
        let isMeAdmin = false;

        if (g.participants && Array.isArray(g.participants) && myJidClean) {
          const me = g.participants.find((p) => {
            const pIdClean = p.id?.split(":")[0]?.split("@")[0];
            return pIdClean === myJidClean;
          });
          if (me && (me.admin === "admin" || me.admin === "superadmin")) {
            isMeAdmin = true;
          }
        }

        const canSend = !isAdminOnly || isMeAdmin;

        const formattedParticipants = (g.participants || []).map((p) => {
          let pNum = p.phoneNumber || "";
          if (!pNum && p.id?.endsWith("@s.whatsapp.net")) {
            pNum = p.id.split("@")[0].split(":")[0];
          }
          return {
            id: p.id,
            admin: p.admin || null,
            phoneNumber: pNum,
            lid: p.id?.endsWith("@lid") ? p.id : null,
          };
        });

        return {
          updateOne: {
            filter: { sessionId, jid: g.id },
            update: {
              $set: {
                userId: session.userId,
                sessionId,
                jid: g.id,
                subject: g.subject || "WhatsApp Group",
                description: typeof g.desc === "string" ? g.desc : "",
                owner: g.owner || null,
                creation: g.creation || null,
                participants: formattedParticipants,
                participantCount: formattedParticipants.length,
                announce: isAdminOnly,
                restrict: g.restrict === true || g.restrict === "true",
                size: g.size || formattedParticipants.length,
                canSend,
                isMeAdmin,
                lastSyncedAt: new Date(),
              },
            },
            upsert: true,
          },
        };
      });

      await WhatsAppGroup.bulkWrite(bulkOps, { ordered: false });

      // Update total groups count on session
      const totalCount = await WhatsAppGroup.countDocuments({ sessionId });
      await WhatsAppSession.updateOne(
        { sessionId },
        { $set: { groupsCount: totalCount } }
      );

      if (io) {
        io.to(sessionId).emit("groups:upsert", { sessionId, count: groups.length });
        for (const g of groups) {
          io.to(sessionId).emit("group:updated", { sessionId, jid: g.id });
        }
      }
    } catch (err) {
      console.warn(`[GROUP SYNC] Error handling groups.upsert:`, err.message);
    }
  }

  /**
   * Handle Baileys 'groups.update' event (subject, description, settings changed).
   */
  async handleGroupsUpdate(sessionId, updates, sock, io) {
    if (!Array.isArray(updates) || updates.length === 0) return;

    try {
      const myJidClean = sock?.user?.id?.split(":")[0]?.split("@")[0];

      for (const update of updates) {
        if (!update.id) continue;

        const updateFields = {
          lastSyncedAt: new Date(),
        };

        if (update.subject !== undefined) updateFields.subject = update.subject;
        if (update.desc !== undefined) updateFields.description = update.desc;
        if (update.announce !== undefined) {
          updateFields.announce = update.announce === true || update.announce === "true";
        }
        if (update.restrict !== undefined) {
          updateFields.restrict = update.restrict === true || update.restrict === "true";
        }

        const existing = await WhatsAppGroup.findOne({ sessionId, jid: update.id });
        if (existing) {
          if (updateFields.announce !== undefined) {
            updateFields.canSend = !updateFields.announce || existing.isMeAdmin;
          }

          await WhatsAppGroup.updateOne(
            { sessionId, jid: update.id },
            { $set: updateFields }
          );

          if (io) {
            io.to(sessionId).emit("group:updated", {
              sessionId,
              jid: update.id,
              updates: updateFields,
            });
          }
        }
      }
    } catch (err) {
      console.warn(`[GROUP SYNC] Error handling groups.update:`, err.message);
    }
  }

  /**
   * Handle Baileys 'group-participants.update' event (member added, removed, promoted, demoted).
   * Updates participant array and counts in MongoDB without full fetch.
   */
  async handleGroupParticipantsUpdate(sessionId, event, sock, io) {
    const { id: groupId, participants, action } = event || {};
    if (!groupId || !Array.isArray(participants) || !action) return;

    try {
      const group = await WhatsAppGroup.findOne({ sessionId, jid: groupId });
      if (!group) {
        // If not in DB yet, fetch fresh from socket and save
        if (sock) {
          try {
            const meta = await sock.groupMetadata(groupId);
            if (meta) {
              await this.handleGroupsUpsert(sessionId, [meta], sock, io);
            }
          } catch (_) {}
        }
        return;
      }

      const myJidClean = sock?.user?.id?.split(":")[0]?.split("@")[0];
      let currentParticipants = [...(group.participants || [])];

      if (action === "add") {
        const newParticipants = participants.map((pId) => ({
          id: pId,
          admin: null,
          phoneNumber: pId.endsWith("@s.whatsapp.net") ? pId.split("@")[0].split(":")[0] : "",
          lid: pId.endsWith("@lid") ? pId : null,
        }));

        // Resolve LIDs for newly added members if needed
        if (sock) {
          await resolveParticipantsLids(sock, newParticipants);
        }

        // Avoid duplicates
        for (const np of newParticipants) {
          if (!currentParticipants.some((p) => p.id === np.id)) {
            currentParticipants.push(np);
          }
        }
      } else if (action === "remove") {
        currentParticipants = currentParticipants.filter(
          (p) => !participants.includes(p.id)
        );
      } else if (action === "promote") {
        currentParticipants = currentParticipants.map((p) => {
          if (participants.includes(p.id)) {
            return { ...p, admin: "admin" };
          }
          return p;
        });
      } else if (action === "demote") {
        currentParticipants = currentParticipants.map((p) => {
          if (participants.includes(p.id)) {
            return { ...p, admin: null };
          }
          return p;
        });
      }

      // Re-evaluate admin & canSend status
      let isMeAdmin = false;
      if (myJidClean) {
        const me = currentParticipants.find((p) => {
          const pIdClean = p.id?.split(":")[0]?.split("@")[0];
          return pIdClean === myJidClean;
        });
        if (me && (me.admin === "admin" || me.admin === "superadmin")) {
          isMeAdmin = true;
        }
      }

      const canSend = !group.announce || isMeAdmin;

      group.participants = currentParticipants;
      group.participantCount = currentParticipants.length;
      group.size = currentParticipants.length;
      group.isMeAdmin = isMeAdmin;
      group.canSend = canSend;
      group.lastSyncedAt = new Date();

      await group.save();

      if (io) {
        const payload = {
          sessionId,
          jid: groupId,
          action,
          participants,
          participantCount: currentParticipants.length,
          canSend,
          isMeAdmin,
        };
        io.to(sessionId).emit("group:participants_updated", payload);
        io.to(sessionId).emit("group:updated", { sessionId, jid: groupId });
      }
    } catch (err) {
      console.warn(`[GROUP SYNC] Error handling group-participants.update:`, err.message);
    }
  }

  /**
   * Fast MongoDB read with search, pagination, and sorting.
   */
  async getGroups(sessionId, userId, queryParams = {}) {
    const { search = "", page, limit, sort = "participants", light = false } = queryParams;

    const filter = { sessionId, userId };

    if (search && search.trim()) {
      filter.subject = { $regex: search.trim(), $options: "i" };
    }

    let sortOptions = { participantCount: -1, subject: 1 };
    if (sort === "name") sortOptions = { subject: 1 };
    else if (sort === "recent") sortOptions = { updatedAt: -1 };

    let query = WhatsAppGroup.find(filter).sort(sortOptions);

    // Light projection omits heavy participants array for ultra-fast list rendering
    if (light === true || light === "true") {
      query = query.select({
        sessionId: 1,
        jid: 1,
        subject: 1,
        description: 1,
        participantCount: 1,
        announce: 1,
        restrict: 1,
        canSend: 1,
        isMeAdmin: 1,
        owner: 1,
        profilePic: 1,
        lastSyncedAt: 1,
        updatedAt: 1,
      });
    }

    // Optional pagination
    if (page && limit) {
      const pageNum = Math.max(1, parseInt(page, 10) || 1);
      const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10) || 50));
      const skip = (pageNum - 1) * limitNum;

      const [groups, total] = await Promise.all([
        query.skip(skip).limit(limitNum).lean(),
        WhatsAppGroup.countDocuments(filter),
      ]);

      const mappedGroups = groups.map((g) => ({ ...g, id: g.jid }));
      return {
        groups: mappedGroups,
        total,
        page: pageNum,
        limit: limitNum,
        hasMore: skip + groups.length < total,
      };
    }

    // If no pagination requested, return all records (backward-compatible)
    const groups = await query.lean();
    const mappedGroups = groups.map((g) => ({ ...g, id: g.jid }));
    return {
      groups: mappedGroups,
      total: groups.length,
      page: 1,
      limit: groups.length,
      hasMore: false,
    };
  }

  /**
   * Get single group details from MongoDB. Fallback to Baileys if missing.
   */
  async getGroupMetadata(sessionId, userId, groupId, sock) {
    let group = await WhatsAppGroup.findOne({ sessionId, userId, jid: groupId }).lean();

    // If not in DB, fetch from socket and save
    if (!group && sock) {
      try {
        const meta = await sock.groupMetadata(groupId);
        if (meta) {
          const session = await WhatsAppSession.findOne({ sessionId, userId });
          if (session) {
            await this.handleGroupsUpsert(sessionId, [meta], sock, null);
            group = await WhatsAppGroup.findOne({ sessionId, userId, jid: groupId }).lean();
          }
        }
      } catch (e) {
        console.warn(`[GROUP SYNC] Fallback metadata fetch error for ${groupId}:`, e.message);
      }
    }

    if (group) {
      return { ...group, id: group.jid };
    }
    return null;
  }
}

export default new GroupSyncService();
