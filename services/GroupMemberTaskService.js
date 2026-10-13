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
      membersPerBatch: Math.max(1, Math.min(10, Number(membersPerBatch) || 2)),
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

      const batchLimit = Math.max(1, Math.min(10, Number(task.membersPerBatch) || 2));
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
            task.stats.added++;
            task.stats.pending--;
            continue;
          }

          pendingMembers.push(m);
          if (pendingMembers.length >= batchLimit) {
            break;
          }
        }
      }

      if (pendingMembers.length === 0) {
        const anyRemaining = task.members.some((m) => m.status === "pending");
        if (!anyRemaining) {
          task.status = "completed";
          await task.save();
          this.activeTasks.delete(String(taskId));
          console.log(`[GroupMemberTask] Task ${taskId} completed successfully!`);
          break;
        }
        await task.save();
        continue;
      }

      const addingSessions = task.addingSessions || [];
      const rotationMode = task.rotationMode || "round-robin";

      // 1. Determine primary account rotation for this batch
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

      // Multi-Account Failover Loop: Try adding the batch with primary account, and fallback to other accounts for any failed numbers
      for (let attempt = 0; attempt < orderedCandidateSessions.length; attempt++) {
        if (controlState.abort || unresolvedMembers.length === 0) break;
        const candidate = orderedCandidateSessions[attempt];
        const sId = candidate.sessionId;

        const sock = await this.waitForSessionConnection(sId, 2500, () => controlState.abort);
        if (!sock || !sock?.user?.id) {
          continue;
        }

        const activePhone = (sock.user?.id || "").split("@")[0].split(":")[0];
        const sName = candidate.name || "WhatsApp Account";
        const batchJids = unresolvedMembers.map((m) => m.jid);
        const phonesList = unresolvedMembers.map((m) => `+${m.phone}`).join(", ");

        try {
          console.log(
            `[GroupMemberTask] Batch adding [${phonesList}] (${unresolvedMembers.length} numbers) directly to ${task.targetGroup.jid} via account ${sName} (+${activePhone}) [Candidate ${attempt + 1}/${orderedCandidateSessions.length}]`
          );

          await GroupMemberTask.findByIdAndUpdate(taskId, {
            lastError: `Adding batch of ${unresolvedMembers.length} number(s) (${phonesList}) via account ${sName} (+${activePhone})...`,
          });

          const response = await sock.groupParticipantsUpdate(
            task.targetGroup.jid,
            batchJids,
            "add"
          );

          const newlyResolved = [];

          for (const m of unresolvedMembers) {
            let resData = null;
            if (response && typeof response === "object") {
              resData =
                response[m.jid] ||
                (Array.isArray(response)
                  ? response.find((r) => r.jid === m.jid || r.id === m.jid)
                  : null);
            }
            const statusCode = String(resData?.status || resData?.code || (response ? "200" : "500"));

            if (statusCode === "200" || statusCode === "207" || statusCode === "409") {
              m.status = "added";
              m.addedAt = new Date();
              m.error = "";
              m.assignedSessionId = sId;
              m.processedBySessionId = sId;
              m.processedByName = sName;
              m.processedByPhoneNumber = activePhone;
              task.stats.added++;
              task.stats.pending--;
              newlyResolved.push(m);

              const cPhone = String(m.phone).replace(/\D/g, "");
              if (cachedExistingParticipants) {
                cachedExistingParticipants.add(cPhone);
                if (cPhone.length > 10) cachedExistingParticipants.add(cPhone.slice(-10));
              }
            } else if (statusCode === "403" || statusCode === "408") {
              memberErrors.set(m.jid, "Direct add restricted by WhatsApp (Account is not group admin or contact's privacy settings restrict group additions).");
              console.warn(`[GroupMemberTask] Account ${sName} received status ${statusCode} for +${m.phone}. Retrying with next account...`);
            } else {
              memberErrors.set(m.jid, resData?.message || `WhatsApp status code ${statusCode}`);
            }
          }

          unresolvedMembers = unresolvedMembers.filter((m) => !newlyResolved.includes(m));
        } catch (batchErr) {
          console.warn(`[GroupMemberTask] Batch add attempt failed for account ${sName}:`, batchErr.message);
          for (const m of unresolvedMembers) {
            memberErrors.set(m.jid, batchErr.message || "Direct addition error.");
          }
          continue;
        }
      }

      // Handle any members that could not be added across all candidate accounts
      if (unresolvedMembers.length > 0) {
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
                m.error = "Direct add restricted. Group invite link sent via DM.";
                task.stats.invited++;
                task.stats.pending--;
              }
            } catch (e) {}
          }

          if (!sentInvite) {
            m.status = "failed";
            m.error = memberErrors.get(m.jid) || "Direct add restricted by WhatsApp (Account is not group admin or contact's privacy settings restrict group additions).";
            task.stats.failed++;
            task.stats.pending--;
          }
        }
      }

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
