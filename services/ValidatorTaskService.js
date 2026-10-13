import ValidatorTask from '../models/ValidatorTask.js';
import WhatsAppSession from '../models/WhatsAppSession.js';
import WhatsAppService from './WhatsAppService.js';
import NumberList from '../models/NumberList.js';
import SubscriptionService from './SubscriptionService.js';

class ValidatorTaskService {
  constructor() {
    this.activeTasks = new Map(); // taskId (string) -> { abort: boolean, paused: boolean }
  }

  /**
   * Helper to normalize a phone number with default country code
   */
  cleanPhoneNumber(rawNumber, defaultCountryCode = '91') {
    if (!rawNumber) return null;
    const rawStr = String(rawNumber).trim();
    const digits = rawStr.replace(/\D/g, '');
    if (!digits || digits.length < 7) return null;

    const defaultCc = String(defaultCountryCode || '91').replace(/\D/g, '');
    let normalized = digits;
    if (digits.length === 10) {
      normalized = `${defaultCc}${digits}`;
    }

    return {
      raw: rawStr,
      digits: normalized,
      phone: `+${normalized}`,
      jid: `${normalized}@s.whatsapp.net`,
    };
  }

  /**
   * Create and start a background validation task
   */
  async createTask(userId, payload) {
    const {
      name,
      numbers = [],
      sessionIds = [],
      batchSize = 10,
      delaySeconds = 2,
      defaultCountryCode = '91',
      autoRemoveInvalid = false,
    } = payload;

    if (!Array.isArray(numbers) || numbers.length === 0) {
      throw new Error('Please provide at least one phone number to validate.');
    }

    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      throw new Error('Please select at least one connected WhatsApp device.');
    }

    // Resolve sessions belonging to user
    const dbSessions = await WhatsAppSession.find({
      userId,
      sessionId: { $in: sessionIds },
    }).lean();

    if (!dbSessions || dbSessions.length === 0) {
      throw new Error('None of the selected WhatsApp devices were found for this user.');
    }

    // Map sessions to lightweight objects
    const resolvedSessions = dbSessions.map((s) => ({
      sessionId: s.sessionId,
      sessionName: s.sessionName || s.phoneNumber || s.sessionId,
      phoneNumber: s.phoneNumber ? (s.phoneNumber.startsWith('+') ? s.phoneNumber : `+${s.phoneNumber}`) : '',
    }));

    // Normalize input numbers and deduplicate
    const parsedNumbers = [];
    const seenDigits = new Set();

    for (const raw of numbers) {
      const parsed = this.cleanPhoneNumber(raw, defaultCountryCode);
      if (parsed && !seenDigits.has(parsed.digits)) {
        seenDigits.add(parsed.digits);
        parsedNumbers.push({
          phone: parsed.phone,
          raw: parsed.raw,
          digits: parsed.digits,
          jid: parsed.jid,
          isValid: false,
          status: 'pending',
          error: '',
          checkedBySessionId: '',
          checkedByPhone: '',
          processedAt: null,
        });
      }
    }

    if (parsedNumbers.length === 0) {
      throw new Error('No valid phone numbers found in the provided input.');
    }

    const effectiveBatchSize = Math.max(1, Math.min(Number(batchSize) || 10, 50));
    const effectiveDelay = Math.max(1, Math.min(Number(delaySeconds) || 2, 30));
    const totalBatches = Math.ceil(parsedNumbers.length / effectiveBatchSize);

    const task = new ValidatorTask({
      userId,
      name: (name || '').trim() || `Validation Task (${parsedNumbers.length} numbers)`,
      selectedSessions: resolvedSessions,
      batchSize: effectiveBatchSize,
      delaySeconds: effectiveDelay,
      defaultCountryCode: String(defaultCountryCode || '91'),
      autoRemoveInvalid: Boolean(autoRemoveInvalid),
      status: 'running',
      currentBatch: 0,
      totalBatches,
      activeDevice: resolvedSessions[0]?.phoneNumber || resolvedSessions[0]?.sessionName || '',
      numbers: parsedNumbers,
      stats: {
        total: parsedNumbers.length,
        valid: 0,
        invalid: 0,
        pending: parsedNumbers.length,
        progressPercent: 0,
      },
    });

    await task.save();

    // Start background asynchronous runner loop
    const controlState = { abort: false, paused: false };
    this.activeTasks.set(String(task._id), controlState);

    this.runTaskLoop(task._id, controlState).catch((err) => {
      console.error(`[ValidatorTask] Task ${task._id} execution failed:`, err);
    });

    return task;
  }

  /**
   * Background runner loop with round-robin multi-device rotation and precaution delay
   */
  async runTaskLoop(taskId, controlState) {
    const taskIdStr = String(taskId);

    try {
      const task = await ValidatorTask.findById(taskId);
      if (!task) return;

      const sessions = task.selectedSessions || [];
      const batchSize = Math.max(1, task.batchSize || 10);
      const delayMs = Math.max(500, (task.delaySeconds || 2) * 1000);

      let batchIndex = 0;

      while (true) {
        // Check for cancellation or pause
        if (controlState.abort) {
          task.status = 'stopped';
          await task.save();
          this.activeTasks.delete(taskIdStr);
          return;
        }

        if (controlState.paused) {
          task.status = 'paused';
          await task.save();
          this.activeTasks.delete(taskIdStr);
          return;
        }

        // Find next chunk of pending numbers
        const pendingIndexes = [];
        for (let idx = 0; idx < task.numbers.length; idx++) {
          if (task.numbers[idx].status === 'pending') {
            pendingIndexes.push(idx);
            if (pendingIndexes.length >= batchSize) break;
          }
        }

        // All numbers processed
        if (pendingIndexes.length === 0) {
          break;
        }

        batchIndex++;
        task.currentBatch = batchIndex;

        // Round-robin device selection
        const assignedSessionMeta = sessions.length > 0
          ? sessions[(batchIndex - 1) % sessions.length]
          : null;
        const targetSessionId = assignedSessionMeta?.sessionId;
        const targetPhoneDisplay = assignedSessionMeta?.phoneNumber || assignedSessionMeta?.sessionName || targetSessionId || 'Rotated Device';

        task.activeDevice = targetPhoneDisplay;

        // Obtain active socket for this session
        let sock = targetSessionId ? WhatsAppService.sockets.get(targetSessionId) : null;

        // If preferred rotated socket is unavailable, fallback to any other connected session in task
        if (!sock || !WhatsAppService.isSocketOpen(sock)) {
          for (const s of sessions) {
            const fallbackSock = WhatsAppService.sockets.get(s.sessionId);
            if (fallbackSock && WhatsAppService.isSocketOpen(fallbackSock)) {
              sock = fallbackSock;
              break;
            }
          }
        }

        const chunkJids = pendingIndexes.map((idx) => task.numbers[idx].jid);

        if (sock && WhatsAppService.isSocketOpen(sock)) {
          try {
            const waResults = await sock.onWhatsApp(...chunkJids);
            const validMap = new Map();

            if (Array.isArray(waResults)) {
              for (const item of waResults) {
                if (item && (item.exists === true || item.jid)) {
                  const cleanJid = String(item.jid || '').toLowerCase();
                  const numPart = cleanJid.replace(/@.*/, '').replace(/:\d+$/, '');
                  validMap.set(numPart, cleanJid);
                }
              }
            }

            for (const idx of pendingIndexes) {
              const item = task.numbers[idx];
              const matchedJid = validMap.get(item.digits);
              const isValid = !!matchedJid;

              item.isValid = isValid;
              item.status = isValid ? 'valid' : 'invalid';
              if (matchedJid) item.jid = matchedJid;
              item.checkedBySessionId = targetSessionId || '';
              item.checkedByPhone = targetPhoneDisplay;
              item.processedAt = new Date();
              item.error = '';
            }
          } catch (chunkErr) {
            console.warn(`[ValidatorTask] Chunk check warning on ${targetPhoneDisplay}:`, chunkErr.message);
            for (const idx of pendingIndexes) {
              const item = task.numbers[idx];
              item.isValid = false;
              item.status = 'invalid';
              item.checkedBySessionId = targetSessionId || '';
              item.checkedByPhone = targetPhoneDisplay;
              item.processedAt = new Date();
              item.error = chunkErr.message || 'Verification query failed';
            }
          }
        } else {
          // Socket not available
          console.warn(`[ValidatorTask] No open WhatsApp socket for batch ${batchIndex}`);
          for (const idx of pendingIndexes) {
            const item = task.numbers[idx];
            item.isValid = false;
            item.status = 'invalid';
            item.processedAt = new Date();
            item.error = 'WhatsApp account not connected during check';
          }
        }

        // Update statistics
        const total = task.numbers.length;
        const valid = task.numbers.filter((n) => n.isValid).length;
        const invalid = task.numbers.filter((n) => n.status === 'invalid').length;
        const pending = task.numbers.filter((n) => n.status === 'pending').length;
        const progressPercent = total > 0 ? Math.round(((total - pending) / total) * 100) : 100;

        task.stats = {
          total,
          valid,
          invalid,
          pending,
          progressPercent,
        };

        // High-performance atomic selective update in MongoDB (avoids 10MB document rewrite on every batch)
        const updateFields = {
          currentBatch: batchIndex,
          activeDevice: targetPhoneDisplay,
          stats: task.stats,
        };

        for (const idx of pendingIndexes) {
          const item = task.numbers[idx];
          updateFields[`numbers.${idx}.isValid`] = item.isValid;
          updateFields[`numbers.${idx}.status`] = item.status;
          updateFields[`numbers.${idx}.jid`] = item.jid;
          updateFields[`numbers.${idx}.checkedBySessionId`] = item.checkedBySessionId;
          updateFields[`numbers.${idx}.checkedByPhone`] = item.checkedByPhone;
          updateFields[`numbers.${idx}.processedAt`] = item.processedAt;
          updateFields[`numbers.${idx}.error`] = item.error || '';
        }

        await ValidatorTask.updateOne({ _id: taskId }, { $set: updateFields });

        // Check if more pending numbers remain before pausing for precaution delay
        if (pending > 0 && !controlState.abort && !controlState.paused) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }

      // Mark completed
      task.status = 'completed';
      task.completedAt = new Date();
      task.stats.pending = 0;
      task.stats.progressPercent = 100;

      await ValidatorTask.updateOne(
        { _id: taskId },
        {
          $set: {
            status: 'completed',
            completedAt: task.completedAt,
            'stats.pending': 0,
            'stats.progressPercent': 100,
          },
        }
      );
    } catch (err) {
      console.error(`[ValidatorTask] Unexpected error in task ${taskIdStr}:`, err);
      try {
        await ValidatorTask.findByIdAndUpdate(taskId, {
          status: 'failed',
          lastError: err.message || 'Task failed unexpectedly',
        });
      } catch (_) {}
    } finally {
      this.activeTasks.delete(taskIdStr);
    }
  }

  /**
   * List all validator tasks for a user
   */
  async listTasks(userId, limit = 30) {
    return ValidatorTask.find({ userId })
      .sort({ createdAt: -1 })
      .select('name status selectedSessions batchSize delaySeconds defaultCountryCode stats activeDevice currentBatch totalBatches completedAt createdAt updatedAt')
      .limit(limit)
      .lean();
  }

  /**
   * Ultra-lightweight progress polling query for live tasks (avoids transferring 55k+ numbers every second)
   */
  async getTaskProgress(userId, taskId) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId })
      .select('name status stats activeDevice currentBatch totalBatches updatedAt numbers')
      .lean();

    if (!task) throw new Error('Validation task not found.');

    const recentProcessed = [];
    const nextPending = [];

    if (Array.isArray(task.numbers)) {
      for (let i = 0; i < task.numbers.length; i++) {
        const item = task.numbers[i];
        if (item.status === 'pending' && nextPending.length < 10) {
          nextPending.push({ phone: item.phone, digits: item.digits, status: item.status });
        }
        if (item.processedAt) {
          recentProcessed.push(item);
        }
      }
    }

    recentProcessed.sort((a, b) => new Date(b.processedAt || 0) - new Date(a.processedAt || 0));

    return {
      _id: task._id,
      name: task.name,
      status: task.status,
      stats: task.stats,
      activeDevice: task.activeDevice,
      currentBatch: task.currentBatch,
      totalBatches: task.totalBatches,
      updatedAt: task.updatedAt,
      recentProcessed: recentProcessed.slice(0, 25),
      nextPending: nextPending.slice(0, 10),
    };
  }

  /**
   * Get single task with full number details
   */
  async getTask(userId, taskId) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId }).lean();
    if (!task) throw new Error('Validation task not found.');
    return task;
  }

  /**
   * Get currently active (running or paused) task for user, or latest task
   */
  async getActiveTask(userId) {
    // 1. Look for currently running task
    let task = await ValidatorTask.findOne({
      userId,
      status: 'running',
    })
      .sort({ updatedAt: -1 })
      .lean();

    // 2. Look for paused task
    if (!task) {
      task = await ValidatorTask.findOne({
        userId,
        status: 'paused',
      })
        .sort({ updatedAt: -1 })
        .lean();
    }

    // 3. Fallback to latest task if within last 12 hours
    if (!task) {
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
      task = await ValidatorTask.findOne({
        userId,
        createdAt: { $gte: twelveHoursAgo },
      })
        .sort({ createdAt: -1 })
        .lean();
    }

    return task;
  }

  /**
   * Pause a running task
   */
  async pauseTask(userId, taskId) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Task not found.');

    const taskIdStr = String(taskId);
    if (this.activeTasks.has(taskIdStr)) {
      const ctrl = this.activeTasks.get(taskIdStr);
      ctrl.paused = true;
    }

    task.status = 'paused';
    await task.save();
    return task;
  }

  /**
   * Resume a paused or stopped task
   */
  async resumeTask(userId, taskId) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Task not found.');

    if (task.status === 'running' && this.activeTasks.has(String(taskId))) {
      return task;
    }

    task.status = 'running';
    task.lastError = '';
    await task.save();

    const controlState = { abort: false, paused: false };
    this.activeTasks.set(String(taskId), controlState);

    this.runTaskLoop(task._id, controlState).catch((err) => {
      console.error(`[ValidatorTask] Resume task ${taskId} error:`, err);
    });

    return task;
  }

  /**
   * Stop / abort a running task
   */
  async stopTask(userId, taskId) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Task not found.');

    const taskIdStr = String(taskId);
    if (this.activeTasks.has(taskIdStr)) {
      const ctrl = this.activeTasks.get(taskIdStr);
      ctrl.abort = true;
    }

    task.status = 'stopped';
    await task.save();
    return task;
  }

  /**
   * Delete a task
   */
  async deleteTask(userId, taskId) {
    const taskIdStr = String(taskId);
    if (this.activeTasks.has(taskIdStr)) {
      const ctrl = this.activeTasks.get(taskIdStr);
      ctrl.abort = true;
      this.activeTasks.delete(taskIdStr);
    }
    return ValidatorTask.findOneAndDelete({ _id: taskId, userId });
  }

  /**
   * Save valid numbers from a task directly into a new NumberList
   */
  async saveToContactList(userId, taskId, customListName) {
    const task = await ValidatorTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Validation task not found.');

    const validPhones = task.numbers
      .filter((n) => n.isValid)
      .map((n) => n.phone);

    if (validPhones.length === 0) {
      throw new Error('This task does not contain any valid WhatsApp numbers to save.');
    }

    const uniqueNumbers = [...new Set(validPhones)];
    const listTitle = (customListName || '').trim() || `${task.name} (Verified)`;

    // Check subscription limits
    const userDoc = await (await import('../models/User.js')).default.findById(userId);
    if (userDoc) {
      if (typeof SubscriptionService.assertContactsLimit === 'function') {
        await SubscriptionService.assertContactsLimit(userDoc, uniqueNumbers.length);
      } else {
        await SubscriptionService.assertResourceLimit(userDoc, 'numberLists', 1);
      }
    }

    const newList = new NumberList({
      userId,
      name: listTitle,
      numbers: uniqueNumbers,
      tags: ['verified', 'whatsapp-validator'],
      color: '#10b981',
    });

    await newList.save();
    return newList;
  }
}

export default new ValidatorTaskService();
