import GroupMemberTask from "../models/GroupMemberTask.js";
import WhatsAppService from "./WhatsAppService.js";
import { WhatsAppSession as SessionModel } from "../models/index.js";

class GroupMemberTaskService {
  constructor() {
    this.activeTasks = new Map();
  }

  async createTask(userId, data) {
    const {
      name,
      targetGroup,
      addingSessions,
      members,
      delaySeconds = 8,
      delayMaxSeconds = 14,
      batchSize = 10,
      batchCooldownSeconds = 25,
      rotationMode = "round-robin",
      autoSendInviteLink = false,
      skipExistingMembers = true,
      membersPerBatch = 2,
      status = "draft",
    } = data;

    if (!targetGroup || (!targetGroup.jid && !targetGroup.inviteUrl && !targetGroup.inviteCode)) {
      throw new Error("Target group or group invite link is required.");
    }

    if (!addingSessions || addingSessions.length === 0) {
      throw new Error("At least one adding WhatsApp account is required.");
    }

    if (!members || members.length === 0) {
      throw new Error("At least one member phone number is required.");
    }

    const {
      countryCode = "91",
      autoAddCountryCode = true,
      joinBeforeAdding = true,
      joinWaitSeconds = 30,
    } = data;

    const normalizedCountryCode = String(countryCode || "91").replace(/\D/g, "") || "91";

    const inviteCode = targetGroup.inviteCode || WhatsAppService.extractGroupInviteCode(targetGroup.inviteUrl);
    if (!targetGroup.jid && inviteCode) {
      for (const s of addingSessions) {
        try {
          const info = await WhatsAppService.getGroupInviteInfo(s?.sessionId, inviteCode);
          if (info?.id) {
            targetGroup.jid = info.id.includes("@") ? info.id : `${info.id}@g.us`;
            if (!targetGroup.subject && info.subject) {
              targetGroup.subject = info.subject;
            }
            break;
          }
        } catch (e) {
          // Can be resolved on join at runtime
        }
      }
    }

    const formattedMembers = members.map((m, index) => {
      let clean = String(m.phone).replace(/\D/g, "");
      // If number is 10 digits without country code, auto-prefix with country code (default 91)
      if (clean.length === 10 && autoAddCountryCode !== false) {
        clean = `${normalizedCountryCode}${clean}`;
      }
      const rotatedSession = addingSessions[index % addingSessions.length];
      const assignedId = m.assignedSessionId || (rotatedSession ? rotatedSession.sessionId : addingSessions[0].sessionId);
      
      return {
        phone: clean,
        jid: `${clean}@s.whatsapp.net`,
        assignedSessionId: assignedId,
        processedBySessionId: assignedId,
        processedByPhoneNumber: rotatedSession?.phoneNumber || "",
        processedByName: rotatedSession?.name || "",
        status: "pending",
      };
    });

    const minDelay = Math.max(2, Number(delaySeconds) || 8);
    const maxDelay = Math.max(minDelay, Number(delayMaxSeconds) || (minDelay + 6));

    const task = new GroupMemberTask({
      userId,
      name: name || `Add Members Task - ${targetGroup.subject || targetGroup.jid || "Invite Group"}`,
      targetGroup: {
        jid: targetGroup.jid || "",
        subject: targetGroup.subject || "",
        inviteCode: inviteCode || "",
        inviteUrl: targetGroup.inviteUrl || "",
      },
      addingSessions,
      members: formattedMembers,
      delaySeconds: minDelay,
      delayMaxSeconds: maxDelay,
      membersPerBatch: Math.max(1, Math.min(100, Number(membersPerBatch) || 2)),
      batchSize: Math.max(1, Number(batchSize) || 10),
      batchCooldownSeconds: Math.max(5, Number(batchCooldownSeconds) || 25),
      rotationMode: rotationMode || "round-robin",
      autoSendInviteLink: Boolean(autoSendInviteLink),
      skipExistingMembers: skipExistingMembers !== false,
      countryCode: normalizedCountryCode,
      autoAddCountryCode: autoAddCountryCode !== false,
      joinBeforeAdding: joinBeforeAdding !== false,
      joinWaitSeconds: Math.max(5, Number(joinWaitSeconds) || 30),
      status: status === "running" ? "running" : "draft",
      stats: {
        total: formattedMembers.length,
        added: 0,
        invited: 0,
        failed: 0,
        pending: formattedMembers.length,
      },
    });

    await task.save();

    if (status === "running") {
      this.startTask(userId, task._id);
    }

    return task;
  }

  async resolveGroupInvite(userId, sessionId, inviteUrlOrCode) {
    if (!sessionId) {
      throw new Error("A connected WhatsApp account session is required to preview group invite links.");
    }
    const cleanCode = WhatsAppService.extractGroupInviteCode(inviteUrlOrCode);
    if (!cleanCode) {
      throw new Error("Invalid WhatsApp group invite link or code.");
    }
    const info = await WhatsAppService.getGroupInviteInfo(sessionId, cleanCode);
    return info;
  }

  /**
   * Fetch all existing participants of a destination group (via groupJid or invite link)
   * to remove/filter duplicates from queued lists.
   */
  async getGroupParticipants(userId, sessionId, { groupJid, inviteUrl, autoJoin = false }) {
    let resolvedJid = groupJid || "";
    let resolvedSubject = "";
    let participants = [];

    // Find a working socket
    let sock = sessionId ? WhatsAppService.getSocket(sessionId) : null;
    if (!sock || !WhatsAppService.isSessionWorking(sessionId)) {
      if (sessionId) {
        sock = await this.waitForSessionConnection(sessionId, 3000);
      }
      if (!sock || !sock?.user?.id) {
        for (const [sId, s] of WhatsAppService.sockets.entries()) {
          if (WhatsAppService.isSessionWorking(sId)) {
            sock = s;
            sessionId = sId;
            break;
          }
        }
      }
    }

    if (!sock) {
      throw new Error("No connected WhatsApp account available. Please connect or select an active account.");
    }

    // 1. If groupJid provided and valid, query metadata
    if (resolvedJid && resolvedJid.includes("@")) {
      try {
        const metadata = await WhatsAppService.getGroupMetadata(sessionId, resolvedJid);
        if (metadata) {
          resolvedSubject = metadata.subject || "";
          if (Array.isArray(metadata.participants)) {
            for (const p of metadata.participants) {
              const num = String(p.phoneNumber || p.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
              if (num && num.length >= 10) {
                participants.push({
                  phone: num,
                  jid: p.id || `${num}@s.whatsapp.net`,
                  isAdmin: p.admin === "admin" || p.admin === "superadmin",
                });
              }
            }
          }
        }
      } catch (err) {
        console.warn(`[getGroupParticipants] Error fetching metadata for ${resolvedJid}:`, err.message);
      }
    }

    // 2. If inviteUrl or code is provided
    if (inviteUrl) {
      const code = WhatsAppService.extractGroupInviteCode(inviteUrl);
      if (code) {
        // If autoJoin was requested and account is not in group yet, join it
        if (autoJoin) {
          try {
            console.log(`[getGroupParticipants] Joining group via invite code ${code} to fetch all participants...`);
            const joinedGid = await WhatsAppService.joinGroupViaInvite(sessionId, code);
            if (joinedGid) resolvedJid = joinedGid;
          } catch (joinErr) {
            console.warn(`[getGroupParticipants] Auto-join attempt notice:`, joinErr.message);
          }
        }

        try {
          const inviteInfo = await WhatsAppService.getGroupInviteInfo(sessionId, code);
          if (inviteInfo) {
            if (!resolvedJid && inviteInfo.id) resolvedJid = inviteInfo.id;
            if (!resolvedSubject && inviteInfo.subject) resolvedSubject = inviteInfo.subject;
            if (Array.isArray(inviteInfo.participants) && inviteInfo.participants.length > 0) {
              for (const p of inviteInfo.participants) {
                const num = String(p.phoneNumber || p.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
                if (num && num.length >= 10 && !participants.some((item) => item.phone === num)) {
                  participants.push({
                    phone: num,
                    jid: p.id || `${num}@s.whatsapp.net`,
                    isAdmin: p.admin === "admin" || p.admin === "superadmin",
                  });
                }
              }
            }
          }
        } catch (inviteErr) {
          console.warn(`[getGroupParticipants] Error resolving invite info:`, inviteErr.message);
        }

        // If we have resolvedJid, try fetching full group metadata
        if (resolvedJid && resolvedJid.includes("@")) {
          try {
            const fullMeta = await WhatsAppService.getGroupMetadata(sessionId, resolvedJid);
            if (fullMeta?.participants && Array.isArray(fullMeta.participants)) {
              const fullList = [];
              for (const p of fullMeta.participants) {
                const num = String(p.phoneNumber || p.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
                if (num && num.length >= 10) {
                  fullList.push({
                    phone: num,
                    jid: p.id || `${num}@s.whatsapp.net`,
                    isAdmin: p.admin === "admin" || p.admin === "superadmin",
                  });
                }
              }
              if (fullList.length > 0) {
                participants = fullList;
              }
            }
          } catch (metaErr) {
            // ignore
          }
        }
      }
    }

    // De-duplicate participants by phone
    const seen = new Set();
    const uniqueParticipants = [];
    for (const p of participants) {
      if (!seen.has(p.phone)) {
        seen.add(p.phone);
        uniqueParticipants.push(p);
      }
    }

    return {
      groupJid: resolvedJid,
      subject: resolvedSubject || "Target WhatsApp Group",
      count: uniqueParticipants.length,
      participants: uniqueParticipants,
    };
  }

  // Helper to ensure member report contains processedBy info for UI display
  populateTaskMemberReports(taskDoc) {
    if (!taskDoc || !taskDoc.members) return taskDoc;
    const sessionMap = {};
    for (const s of taskDoc.addingSessions || []) {
      sessionMap[s.sessionId] = s;
    }

    for (const m of taskDoc.members) {
      const targetSessionId = m.processedBySessionId || m.assignedSessionId;
      const meta = sessionMap[targetSessionId];
      if (!m.processedByPhoneNumber && meta) {
        m.processedByPhoneNumber = meta.phoneNumber || "";
      }
      if (!m.processedByName && meta) {
        m.processedByName = meta.name || "";
      }
    }
    return taskDoc;
  }

  async listTasks(userId) {
    const tasks = await GroupMemberTask.find({ userId }).sort({ createdAt: -1 }).lean();
    return tasks.map((t) => this.populateTaskMemberReports(t));
  }

  async getTask(userId, taskId) {
    const task = await GroupMemberTask.findOne({ _id: taskId, userId }).lean();
    if (!task) throw new Error("Task not found.");
    return this.populateTaskMemberReports(task);
  }

  async deleteTask(userId, taskId) {
    this.stopTask(userId, taskId);
    return GroupMemberTask.findOneAndDelete({ _id: taskId, userId });
  }

  async resetFailedMembers(userId, taskId) {
    const task = await GroupMemberTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error("Task not found.");

    let count = 0;
    for (const m of task.members) {
      if (m.status === "failed") {
        m.status = "pending";
        m.error = "";
        count++;
      }
    }

    task.stats.pending += count;
    task.stats.failed = Math.max(0, task.stats.failed - count);
    if (task.status === "completed") {
      task.status = "draft";
    }
    await task.save();
    return task;
  }

  async startTask(userId, taskId) {
    const task = await GroupMemberTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error("Task not found.");

    if (task.status === "running" && this.activeTasks.has(String(taskId))) {
      return task;
    }

    // Auto-reset failed members if there are no pending members remaining!
    const pendingCount = task.members.filter((m) => m.status === "pending").length;
    if (pendingCount === 0 && task.stats.failed > 0) {
      let resetCount = 0;
      for (const m of task.members) {
        if (m.status === "failed") {
          m.status = "pending";
          m.error = "";
          resetCount++;
        }
      }
      task.stats.pending = resetCount;
      task.stats.failed = 0;
    }

    // Evenly rotate pending members round-robin across all live connected addingSessions
    const liveSessions = [];
    for (const s of task.addingSessions || []) {
      if (WhatsAppService.isSessionWorking(s.sessionId)) {
        liveSessions.push(s);
      }
    }
    if (liveSessions.length === 0) {
      for (const [sId, activeSock] of WhatsAppService.sockets.entries()) {
        if (WhatsAppService.isSessionWorking(sId)) {
          liveSessions.push({
            sessionId: sId,
            name: "Connected Account",
            phoneNumber: (activeSock.user?.id || "").split("@")[0].split(":")[0]
          });
        }
      }
    }

    if (liveSessions.length > 0) {
      const liveSessionIds = new Set(liveSessions.map((s) => s.sessionId));
      const hasPreassignedLiveSessions = task.members.some(
        (m) => m.status === "pending" && m.assignedSessionId && liveSessionIds.has(m.assignedSessionId)
      );

      // Only rebalance pending members if existing assigned accounts are completely missing or offline
      if (!hasPreassignedLiveSessions) {
        const batchSz = Math.max(1, task.batchSize || 10);
        let liveIdx = 0;
        for (const m of task.members) {
          if (m.status === "pending") {
            let selectedSession;
            if (task.rotationMode === "batch-switch") {
              const sessionIdx = Math.floor(liveIdx / batchSz) % liveSessions.length;
              selectedSession = liveSessions[sessionIdx];
            } else {
              selectedSession = liveSessions[liveIdx % liveSessions.length];
            }
            if (selectedSession) {
              m.assignedSessionId = selectedSession.sessionId;
            }
            liveIdx++;
          }
        }
      }
    }

    task.status = "running";
    task.lastError = "";
    await task.save();

    const controlState = { abort: false };
    this.activeTasks.set(String(taskId), controlState);

    // Asynchronously run task loop in background
    this.runTaskLoop(task._id, controlState).catch((err) => {
      console.error(`[GroupMemberTask] Error in task ${taskId}:`, err);
    });

    return task;
  }

  async stopTask(userId, taskId) {
    const task = await GroupMemberTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error("Task not found.");

    if (this.activeTasks.has(String(taskId))) {
      const controlState = this.activeTasks.get(String(taskId));
      controlState.abort = true;
      this.activeTasks.delete(String(taskId));
    }

    if (task.status === "running") {
      task.status = "paused";
      await task.save();
    }

    return task;
  }

  /**
   * Parse participant status returned by WhatsApp socket groupParticipantsUpdate.
   * Matches by full JID, normalized phone digits, or domain-stripped phone.
   */
  parseParticipantResult(response, member) {
    if (!response) return null;
    const cleanPhone = String(member.phone || "").replace(/\D/g, "");

    // Check if response is an array or has a participants array
    const items = Array.isArray(response)
      ? response
      : (Array.isArray(response?.participants) ? response.participants : null);

    if (items) {
      for (const item of items) {
        if (!item) continue;
        const rawJid = String(item.jid || item.id || "");
        const rawPhone = rawJid.split("@")[0].split(":")[0].replace(/\D/g, "");
        if (
          rawJid === member.jid ||
          (rawPhone && (rawPhone === cleanPhone || (cleanPhone.length >= 10 && rawPhone.endsWith(cleanPhone.slice(-10)))))
        ) {
          const rawStatus = item.status !== undefined ? item.status : item.code;
          return {
            status: rawStatus !== undefined && rawStatus !== null ? String(rawStatus) : "unknown",
            message: item.message || item.error || "",
            data: item,
          };
        }
      }
      return null;
    }

    // Check if response is a keyed object
    if (typeof response === "object") {
      for (const [key, val] of Object.entries(response)) {
        const rawPhone = String(key).split("@")[0].split(":")[0].replace(/\D/g, "");
        if (
          key === member.jid ||
          (rawPhone && (rawPhone === cleanPhone || (cleanPhone.length >= 10 && rawPhone.endsWith(cleanPhone.slice(-10)))))
        ) {
          if (typeof val === "object" && val !== null) {
            const rawStatus = val.status !== undefined ? val.status : val.code;
            return {
              status: rawStatus !== undefined && rawStatus !== null ? String(rawStatus) : "unknown",
              message: val.message || val.error || "",
              data: val,
            };
          }
          return {
            status: String(val),
            message: "",
            data: val,
          };
        }
      }
    }

    return null;
  }

  /**
   * Robustly check if a WhatsApp session is connected and ready.
   * Uses both authenticated user ID and live WebSocket OPEN readyState.
   * If already working, returns immediately without reconnecting.
   */
  async waitForSessionConnection(sessionId, maxWaitMs = 6000, isAborted = () => false) {
    if (WhatsAppService.isSessionWorking(sessionId)) {
      return WhatsAppService.getSocket(sessionId);
    }

    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (isAborted()) return null;

      if (WhatsAppService.isSessionWorking(sessionId)) {
        return WhatsAppService.getSocket(sessionId);
      }

      // Attempt connect ONLY if socket is missing or not open
      try {
        const hasCreds = await WhatsAppService.validateSessionCredentials(sessionId);
        if (!hasCreds) {
          // No credentials exist for this session in Mongo, don't wait!
          return null;
        }
        if (!WhatsAppService.pendingReconnects.has(sessionId)) {
          console.log(`[GroupMemberTask] Session ${sessionId} not active in memory. Connecting session...`);
          WhatsAppService.connectSession(sessionId).catch(() => {});
        }
      } catch (dbErr) {
        // ignore
      }

      await new Promise((r) => setTimeout(r, 1000));
    }

    if (WhatsAppService.isSessionWorking(sessionId)) {
      return WhatsAppService.getSocket(sessionId);
    }

    return null;
  }

  async runTaskLoop(taskId, controlState) {
    const sleep = (ms) =>
      new Promise((resolve) => {
        const checkInterval = 250;
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += checkInterval;
          if (controlState.abort || elapsed >= ms) {
            clearInterval(interval);
            resolve();
          }
        }, checkInterval);
      });

    console.log(`[GroupMemberTask] Starting execution loop for task ${taskId}`);

    let loopCounter = 0;
    let cachedExistingParticipants = null;
    let cachedInviteCode = null;

    // Pre-execution: Auto-join group via invite code/link if enabled & wait cooldown
    try {
      const initialTask = await GroupMemberTask.findById(taskId);
      if (!initialTask || initialTask.status !== "running") return;

      const inviteCode =
        initialTask.targetGroup?.inviteCode ||
        WhatsAppService.extractGroupInviteCode(initialTask.targetGroup?.inviteUrl);

      if (inviteCode) {
        cachedInviteCode = inviteCode;
      }

      if (
        initialTask.joinBeforeAdding !== false &&
        inviteCode &&
        !initialTask.hasJoinedViaInvite
      ) {
        console.log(`[GroupMemberTask] Pre-join initiated for task ${taskId} using invite code: ${inviteCode}`);

        let resolvedJid = initialTask.targetGroup?.jid;
        let resolvedSubject = initialTask.targetGroup?.subject;

        await GroupMemberTask.findByIdAndUpdate(taskId, {
          lastError: "Joining target group via invite link before adding members...",
        });

        for (const sessionObj of initialTask.addingSessions || []) {
          if (controlState.abort) break;
          const sId = sessionObj.sessionId;
          try {
            console.log(`[GroupMemberTask] Session ${sId} joining group via invite code ${inviteCode}...`);
            const joinedGid = await WhatsAppService.joinGroupViaInvite(sId, inviteCode);
            if (joinedGid) {
              resolvedJid = joinedGid;
            }
          } catch (joinErr) {
            console.warn(`[GroupMemberTask] Session ${sId} failed to join via invite: ${joinErr.message}`);
          }
        }

        // If targetGroup.jid is not known yet, try resolving from invite info
        if (!resolvedJid) {
          for (const sessionObj of initialTask.addingSessions || []) {
            try {
              const info = await WhatsAppService.getGroupInviteInfo(sessionObj.sessionId, inviteCode);
              if (info?.id) {
                resolvedJid = info.id;
                if (!resolvedSubject && info.subject) resolvedSubject = info.subject;
                break;
              }
            } catch (e) {}
          }
        }

        const waitSec = Math.max(5, Number(initialTask.joinWaitSeconds) || 30);
        console.log(`[GroupMemberTask] Target group joined. Waiting ${waitSec}s cooldown before adding members...`);

        await GroupMemberTask.findByIdAndUpdate(taskId, {
          ...(resolvedJid ? { "targetGroup.jid": resolvedJid } : {}),
          ...(resolvedSubject ? { "targetGroup.subject": resolvedSubject } : {}),
          hasJoinedViaInvite: true,
          lastError: `Joined group via invite link. Waiting ${waitSec}s cooldown before starting member additions...`,
        });

        await sleep(waitSec * 1000);

        if (controlState.abort) return;

        // Clear temporary status message
        await GroupMemberTask.findByIdAndUpdate(taskId, {
          lastError: "",
        });
      }
    } catch (preJoinErr) {
      console.error(`[GroupMemberTask] Pre-join error in task ${taskId}:`, preJoinErr);
    }

    while (!controlState.abort) {
      const task = await GroupMemberTask.findById(taskId);
      if (!task || task.status !== "running") break;

      // Ensure targetGroup.jid is valid before attempting member addition
      if (!task.targetGroup?.jid || !task.targetGroup.jid.includes("@")) {
        const inviteCode =
          cachedInviteCode ||
          task.targetGroup?.inviteCode ||
          WhatsAppService.extractGroupInviteCode(task.targetGroup?.inviteUrl);

        if (inviteCode) {
          cachedInviteCode = inviteCode;
          for (const s of task.addingSessions || []) {
            try {
              const info = await WhatsAppService.getGroupInviteInfo(s.sessionId, inviteCode);
              if (info?.id) {
                const cleanJid = info.id.includes("@") ? info.id : `${info.id}@g.us`;
                task.targetGroup.jid = cleanJid;
                if (!task.targetGroup.subject && info.subject) task.targetGroup.subject = info.subject;
                await GroupMemberTask.findByIdAndUpdate(taskId, {
                  "targetGroup.jid": cleanJid,
                  "targetGroup.subject": task.targetGroup.subject,
                });
                break;
              }
            } catch (e) {}
          }
        }
      }

      if (!task.targetGroup?.jid || !task.targetGroup.jid.includes("@")) {
        console.warn(`[GroupMemberTask] Target group JID could not be resolved for task ${taskId}. Pausing task.`);
        task.status = "paused";
        task.lastError = "Target group WhatsApp ID could not be resolved. Please make sure the account has joined the group or select the destination group from 'Select from My Groups'.";
        await task.save();
        this.activeTasks.delete(String(taskId));
        break;
      }

      // Pre-cache existing group participants to accurately auto-skip duplicates
      if (!cachedExistingParticipants && task.targetGroup?.jid) {
        for (const s of task.addingSessions || []) {
          try {
            const meta = await WhatsAppService.getGroupMetadata(s.sessionId, task.targetGroup.jid);
            if (meta?.participants && Array.isArray(meta.participants)) {
              cachedExistingParticipants = new Set();
              for (const p of meta.participants) {
                const pPhone = String(p.phoneNumber || p.id || "").split("@")[0].split(":")[0].replace(/\D/g, "");
                if (pPhone) {
                  cachedExistingParticipants.add(pPhone);
                  if (pPhone.length > 10) cachedExistingParticipants.add(pPhone.slice(-10));
                }
              }
              console.log(`[GroupMemberTask] Cached ${cachedExistingParticipants.size / 2} existing group participants.`);
              break;
            }
          } catch (metaErr) {
            // Can be resolved as accounts connect
          }
        }
      }

      const batchLimit = Math.max(1, Math.min(100, Number(task.membersPerBatch) || 2));
      const pendingMembers = [];

      for (const m of task.members) {
        if (m.status === "pending") {
          const cleanPhone = String(m.phone).replace(/\D/g, "");
          const isAlreadyInGroup =
            cachedExistingParticipants &&
            (cachedExistingParticipants.has(cleanPhone) ||
              (cleanPhone.length > 10 && cachedExistingParticipants.has(cleanPhone.slice(-10))));

          if (isAlreadyInGroup) {
            console.log(`[GroupMemberTask] Precaution: Skipping ${m.phone} - already present in target group.`);
            m.status = "added";
            m.addedAt = new Date();
            m.error = "Already in group (auto-skipped).";
            continue;
          }

          pendingMembers.push(m);
          if (pendingMembers.length >= batchLimit) {
            break;
          }
        }
      }

      if (pendingMembers.length === 0) {
        // Sync stats before completing
        task.stats.added = task.members.filter((m) => m.status === "added").length;
        task.stats.invited = task.members.filter((m) => m.status === "invited").length;
        task.stats.failed = task.members.filter((m) => m.status === "failed").length;
        task.stats.pending = task.members.filter((m) => m.status === "pending").length;
        task.stats.total = task.members.length;

        const anyRemaining = task.members.some((m) => m.status === "pending");
        if (!anyRemaining) {
          task.status = "completed";
          task.lastError = "";
          await task.save();
          this.activeTasks.delete(String(taskId));
          console.log(`[GroupMemberTask] Task ${taskId} completed successfully!`);
          break;
        }
        await task.save();
        continue;
      }

      const addingSessions = task.addingSessions || [];
      if (addingSessions.length === 0) {
        task.status = "paused";
        task.lastError = "No WhatsApp accounts assigned to this task.";
        await task.save();
        this.activeTasks.delete(String(taskId));
        break;
      }

      // Check account connection status: Ensure at least one account is active/reachable
      let reachableAccountFound = false;
      for (const s of addingSessions) {
        if (WhatsAppService.isSessionWorking(s.sessionId)) {
          reachableAccountFound = true;
          break;
        }
      }

      // If no session working in memory, attempt quick connection
      if (!reachableAccountFound) {
        for (const s of addingSessions) {
          const testSock = await this.waitForSessionConnection(s.sessionId, 2500, () => controlState.abort);
          if (testSock && testSock?.user?.id) {
            reachableAccountFound = true;
            break;
          }
        }
      }

      // If ALL accounts are disconnected, PAUSE the task immediately to protect pending queue
      if (!reachableAccountFound) {
        console.warn(`[GroupMemberTask] All assigned accounts for task ${taskId} are disconnected. Pausing task.`);
        task.status = "paused";
        task.lastError = "All assigned WhatsApp accounts are disconnected. Task paused automatically to protect your member queue. Please reconnect or scan your account in WhatsApp Accounts, then click Resume.";
        await task.save();
        this.activeTasks.delete(String(taskId));
        break;
      }

      const rotationMode = task.rotationMode || "round-robin";

      // Determine primary account rotation for this batch
      let primaryIdx = 0;
      if (rotationMode === "batch-switch") {
        const batchSz = Math.max(1, task.batchSize || 10);
        primaryIdx = Math.floor(loopCounter / batchSz) % addingSessions.length;
      } else {
        primaryIdx = loopCounter % addingSessions.length;
      }

      const orderedCandidateSessions = [
        addingSessions[primaryIdx],
        ...addingSessions.filter((_, idx) => idx !== primaryIdx),
      ].filter(Boolean);

      let unresolvedMembers = [...pendingMembers];
      let memberErrors = new Map();
      let attemptedAccountsCount = 0;

      // Multi-Account Failover Loop: Try adding the batch with primary account, fallback to other accounts for restricted numbers
      for (let attempt = 0; attempt < orderedCandidateSessions.length; attempt++) {
        if (controlState.abort || unresolvedMembers.length === 0) break;
        const candidate = orderedCandidateSessions[attempt];
        const sId = candidate.sessionId;

        const sock = await this.waitForSessionConnection(sId, 2500, () => controlState.abort);
        if (!sock || !sock?.user?.id) {
          console.warn(`[GroupMemberTask] Account ${candidate.name || sId} is not connected. Skipping to next account...`);
          continue;
        }

        attemptedAccountsCount++;
        const activePhone = (sock.user?.id || "").split("@")[0].split(":")[0];
        const sName = candidate.name || "WhatsApp Account";
        const batchJids = unresolvedMembers.map((m) => m.jid);
        const phonesList = unresolvedMembers.map((m) => `+${m.phone}`).join(", ");

        try {
          console.log(
            `[GroupMemberTask] Batch adding [${phonesList}] (${unresolvedMembers.length} numbers) to ${task.targetGroup.jid} via ${sName} (+${activePhone}) [Candidate ${attempt + 1}/${orderedCandidateSessions.length}]`
          );

          await GroupMemberTask.findByIdAndUpdate(taskId, {
            lastError: `Adding batch of ${unresolvedMembers.length} number(s) (${phonesList}) via account ${sName} (+${activePhone})...`,
          });

          const response = await sock.groupParticipantsUpdate(
            task.targetGroup.jid,
            batchJids,
            "add"
          );

          console.log(`[GroupMemberTask] Raw WhatsApp response:`, JSON.stringify(response || []));

          const newlyResolved = [];

          for (const m of unresolvedMembers) {
            const parsed = this.parseParticipantResult(response, m);
            const statusCode = String(parsed?.status || "unknown");

            if (statusCode === "200" || statusCode === "207") {
              // Successfully added directly to group
              m.status = "added";
              m.addedAt = new Date();
              m.error = "";
              m.assignedSessionId = sId;
              m.processedBySessionId = sId;
              m.processedByName = sName;
              m.processedByPhoneNumber = activePhone;
              newlyResolved.push(m);

              const cPhone = String(m.phone).replace(/\D/g, "");
              if (cachedExistingParticipants) {
                cachedExistingParticipants.add(cPhone);
                if (cPhone.length > 10) cachedExistingParticipants.add(cPhone.slice(-10));
              }
            } else if (statusCode === "409") {
              // Already a member of the group
              m.status = "added";
              m.addedAt = new Date();
              m.error = "Already in group (status 409)";
              m.assignedSessionId = sId;
              m.processedBySessionId = sId;
              m.processedByName = sName;
              m.processedByPhoneNumber = activePhone;
              newlyResolved.push(m);

              const cPhone = String(m.phone).replace(/\D/g, "");
              if (cachedExistingParticipants) {
                cachedExistingParticipants.add(cPhone);
                if (cPhone.length > 10) cachedExistingParticipants.add(cPhone.slice(-10));
              }
            } else if (statusCode === "403" || statusCode === "408") {
              // Direct add restricted by privacy settings or requires invite code
              memberErrors.set(
                m.jid,
                "Privacy settings restrict direct group addition (Contact only allows contacts or invite links)."
              );
              console.warn(`[GroupMemberTask] Account ${sName} received privacy restriction (status ${statusCode}) for +${m.phone}`);
            } else if (statusCode === "401") {
              // Sender account is not group admin
              memberErrors.set(
                m.jid,
                `Sender account ${sName} is not a group admin or unauthorized to add members.`
              );
              console.warn(`[GroupMemberTask] Account ${sName} is not group admin (status 401).`);
            } else if (statusCode === "404") {
              memberErrors.set(m.jid, "Phone number is not registered on WhatsApp (Status 404).");
            } else if (statusCode === "429") {
              memberErrors.set(m.jid, `WhatsApp temporary rate-limit triggered for account ${sName}.`);
            } else {
              memberErrors.set(
                m.jid,
                parsed?.message || (statusCode !== "unknown" ? `WhatsApp status code ${statusCode}` : "No confirmation received from WhatsApp for this number.")
              );
            }
          }

          unresolvedMembers = unresolvedMembers.filter((m) => !newlyResolved.includes(m));
        } catch (batchErr) {
          console.warn(`[GroupMemberTask] Batch add attempt failed for account ${sName}:`, batchErr.message);
          for (const m of unresolvedMembers) {
            memberErrors.set(m.jid, `Request failed via account ${sName}: ${batchErr.message || "Connection error"}`);
          }
          continue;
        }
      }

      // Handle any members that could not be added directly across all candidate accounts
      if (unresolvedMembers.length > 0) {
        // If not a single account could even be attempted because all disconnected during loop:
        if (attemptedAccountsCount === 0) {
          console.warn(`[GroupMemberTask] No accounts reachable for batch in task ${taskId}. Pausing task.`);
          task.status = "paused";
          task.lastError = "Assigned WhatsApp accounts became disconnected during execution. Task paused to protect member queue.";
          await task.save();
          this.activeTasks.delete(String(taskId));
          break;
        }

        const fallbackSession = orderedCandidateSessions[0] || addingSessions[0];
        for (const m of unresolvedMembers) {
          m.assignedSessionId = fallbackSession?.sessionId || m.assignedSessionId;
          m.processedBySessionId = fallbackSession?.sessionId || m.assignedSessionId;
          m.processedByName = fallbackSession?.name || "WhatsApp Account";
          m.processedByPhoneNumber = fallbackSession?.phoneNumber || "";

          let sentInvite = false;
          if (task.autoSendInviteLink && cachedInviteCode) {
            try {
              const firstSock = await this.waitForSessionConnection(m.assignedSessionId, 2000, () => controlState.abort);
              if (firstSock?.user?.id) {
                const inviteUrl = `https://chat.whatsapp.com/${cachedInviteCode}`;
                await firstSock.sendMessage(m.jid, {
                  text: `Hello! You've been invited to join our WhatsApp group: ${inviteUrl}`,
                });
                sentInvite = true;
                m.status = "invited";
                m.addedAt = new Date();
                m.error = "Privacy restricted: Group invite link sent via DM.";
              }
            } catch (e) {
              console.warn(`[GroupMemberTask] Failed to send invite DM to +${m.phone}:`, e.message);
            }
          }

          if (!sentInvite) {
            m.status = "failed";
            m.error =
              memberErrors.get(m.jid) ||
              "Direct add restricted by WhatsApp (Contact's privacy settings restrict group additions or account is not admin).";
          }
        }
      }

      // Recompute stats directly from task.members to ensure 100% precision
      task.stats.added = task.members.filter((m) => m.status === "added").length;
      task.stats.invited = task.members.filter((m) => m.status === "invited").length;
      task.stats.failed = task.members.filter((m) => m.status === "failed").length;
      task.stats.pending = task.members.filter((m) => m.status === "pending").length;
      task.stats.total = task.members.length;

      await task.save();
      loopCounter++;

      // Anti-Ban Precaution 1: Periodic batch rest cooldown
      const batchSize = Math.max(1, task.batchSize || 10);
      const batchCooldownSec = Math.max(5, task.batchCooldownSeconds || 25);
      if (loopCounter > 0 && loopCounter % batchSize === 0) {
        console.log(`[GroupMemberTask] Anti-ban safety cooldown: Pausing task ${taskId} for ${batchCooldownSec}s after ${loopCounter} batches...`);
        await GroupMemberTask.findByIdAndUpdate(taskId, {
          lastError: `Safety rest break: Cooling down accounts for ${batchCooldownSec}s (completed ${loopCounter} batches)...`,
        });
        await sleep(batchCooldownSec * 1000);
        if (controlState.abort) break;
      }

      // Anti-Ban Precaution 2: Randomized Jitter Pacing Delay
      const minDelay = Math.max(2, Number(task.delaySeconds) || 8);
      const maxDelay = Math.max(minDelay, Number(task.delayMaxSeconds) || (minDelay + 6));
      const jitterSec = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      console.log(`[GroupMemberTask] Anti-ban jitter pacing: Waiting ${jitterSec}s before next batch addition...`);
      await GroupMemberTask.findByIdAndUpdate(taskId, {
        lastError: `Anti-ban jitter pacing: Waiting ${jitterSec}s before processing next batch...`,
      });
      await sleep(jitterSec * 1000);
    }

    if (controlState.abort) {
      console.log(`[GroupMemberTask] Task ${taskId} stopped by user.`);
    }
  }
}

export default new GroupMemberTaskService();
