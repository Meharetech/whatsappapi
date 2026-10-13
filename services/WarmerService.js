import WarmerTask from '../models/WarmerTask.js';
import WhatsAppService from './WhatsAppService.js';
import WhatsAppSession from '../models/WhatsAppSession.js';

const TOPIC_DIALOGUES = {
  casual: [
    "Hey! How is your day going so far?",
    "Hey there! Doing well, just catching up on some work. How about you?",
    "Pretty good! Just brewing some hot coffee right now ☕",
    "Nice! Coffee is a lifesaver today haha.",
    "Totally agree! Did you get a chance to check out that new video?",
    "Not yet, but I have it bookmarked for later tonight!",
    "Awesome, let me know what you think when you watch it.",
    "Will do for sure! Any fun plans for the weekend?",
    "Thinking of going for a hike or quick road trip with friends.",
    "That sounds super refreshing! Hope the weather stays pleasant.",
    "Thanks! Catch up with you again soon.",
    "Sounds great, talk soon! Have a great day!",
  ],
  business: [
    "Good morning! Did you get a chance to review the updated proposal?",
    "Good morning! Yes, I reviewed it earlier today. The roadmap looks very solid.",
    "Excellent. Are you free for a quick 10-minute sync later today?",
    "Yes, I have availability after 3:30 PM. Does that work for you?",
    "3:30 PM works perfectly. I will send over the calendar invite now.",
    "Sounds great. Should we also include the project design lead?",
    "Yes, that would be very helpful to align on milestone deadlines.",
    "Noted! I have added them to the invite thread.",
    "Thank you! Looking forward to our discussion.",
    "Likewise, see you on the call!",
  ],
  ecommerce: [
    "Hello! Is the new collection currently available for immediate dispatch?",
    "Hi! Yes, all items in the new catalog are in stock with express dispatch.",
    "Great! Does standard shipping include real-time package tracking?",
    "Yes, complete real-time tracking is sent automatically via WhatsApp & SMS.",
    "Awesome! Is there any active promo coupon for orders today?",
    "You can apply code SAVE10 at checkout for an instant 10% discount!",
    "Just placed the order now! Thanks for the super fast help.",
    "You're very welcome! We are preparing your package right away.",
    "Appreciate the top-notch service. Have a wonderful day!",
    "Thank you for shopping with us! Have a great day ahead!",
  ],
  support: [
    "Hello, I need a quick update regarding my account verification.",
    "Hi there! I would be glad to assist you. Could you share your reference ticket ID?",
    "Sure, my ticket reference ID is #VER-89421.",
    "Thank you! Checking your status in the system right now...",
    "Everything is verified and all account features are active now!",
    "That was super fast, thank you so much for the resolution!",
    "Always happy to help! Is there anything else you need assistance with today?",
    "No that covers everything. Really appreciate the prompt support!",
    "You're very welcome! Have a fantastic day ahead.",
    "Thanks, you too!",
  ],
  tech: [
    "Hey team, did the new API service release pass all integration tests?",
    "Hey! Yes, all unit and end-to-end regression tests passed with green status.",
    "Terrific! How is the average database query response latency looking?",
    "Averaging around 15ms across all clusters, well within our 50ms SLA.",
    "Awesome. Let's proceed with the blue-green rollout to production.",
    "Rollout started. Monitoring error rates and CPU loads in real-time.",
    "All instances healthy. Zero error spikes detected.",
    "Excellent work on this optimization sprint, everyone!",
    "Thanks! Team effort all around. Updating the release changelog now.",
    "Perfect, great job team!",
  ],
};

class WarmerService {
  constructor() {
    this.io = null;
    // Map of active timer maps: taskId -> Map<laneIndex, timeoutId>
    this.activeTasks = new Map();
    // In-memory conversation state per task lane: taskId -> Map<laneIndex, { dialogueIndex, roundIndex, pair }>
    this.taskStates = new Map();
  }

  setSocketIO(io) {
    this.io = io;
  }

  emitToUser(userId, event, data) {
    if (this.io && userId) {
      const uId = userId.toString();
      this.io.to(`user:${uId}`).emit(event, data);
      this.io.emit(event, { ...data, userId: uId });
    }
  }

  /**
   * Generates round-robin tournament rounds for N sessions.
   * In each round, returns an array of non-overlapping simultaneous pairs: [[A, B], [C, D], ...]
   */
  generateRoundRobinRounds(sessions) {
    if (!sessions || sessions.length < 2) return [];
    
    // Copy array
    const list = [...sessions];
    const isOdd = list.length % 2 !== 0;
    if (isOdd) {
      list.push(null); // dummy placeholder for odd bye
    }

    const n = list.length;
    const totalRounds = n - 1;
    const half = n / 2;
    const rounds = [];

    let currentList = [...list];
    for (let r = 0; r < totalRounds; r++) {
      const pairsInRound = [];
      for (let i = 0; i < half; i++) {
        const a = currentList[i];
        const b = currentList[n - 1 - i];
        if (a !== null && b !== null) {
          pairsInRound.push([a, b]);
        }
      }
      if (pairsInRound.length > 0) {
        rounds.push(pairsInRound);
      }

      // Standard polygon rotation: keep index 0 fixed, rotate rest clockwise
      const fixed = currentList[0];
      const rest = currentList.slice(1);
      const last = rest.pop();
      rest.unshift(last);
      currentList = [fixed, ...rest];
    }

    // Fallback if no rounds generated
    if (rounds.length === 0 && sessions.length >= 2) {
      rounds.push([[sessions[0], sessions[1]]]);
    }

    return rounds;
  }

  getDialoguesForTask(task) {
    if (task.conversationTopic === 'custom' && task.customDialogues?.length > 0) {
      return task.customDialogues.map((d) => d.text).filter(Boolean);
    }
    const topic = task.conversationTopic || 'casual';
    return TOPIC_DIALOGUES[topic] || TOPIC_DIALOGUES.casual;
  }

  /**
   * Create a new Warmer Task
   */
  async createTask(userId, data) {
    const {
      name,
      participatingSessions,
      conversationTopic = 'casual',
      customDialogues = [],
      minDelaySeconds = 15,
      maxDelaySeconds = 45,
      messagesPerSession = 20,
    } = data;

    if (!participatingSessions || participatingSessions.length < 2) {
      throw new Error('Please select at least 2 connected WhatsApp accounts for warmup chat.');
    }

    // Hydrate phone numbers and names from database if not supplied
    const hydratedSessions = [];
    for (const sess of participatingSessions) {
      const dbSess = await WhatsAppSession.findOne({ sessionId: sess.sessionId, userId });
      hydratedSessions.push({
        sessionId: sess.sessionId,
        name: sess.name || dbSess?.name || sess.sessionId,
        phoneNumber: sess.phoneNumber || dbSess?.phoneNumber || dbSess?.me?.id?.split(':')[0]?.split('@')[0] || '',
      });
    }

    const totalMessagesTarget = Math.max(1, messagesPerSession * hydratedSessions.length);

    const task = new WarmerTask({
      userId,
      name: name?.trim() || `Warmup ${hydratedSessions.length} Numbers (${new Date().toLocaleDateString()})`,
      participatingSessions: hydratedSessions,
      conversationTopic,
      customDialogues: customDialogues.map((t) => (typeof t === 'string' ? { text: t } : t)),
      minDelaySeconds: Math.max(5, Number(minDelaySeconds) || 15),
      maxDelaySeconds: Math.max(Number(minDelaySeconds) || 15, Number(maxDelaySeconds) || 45),
      messagesPerSession: Number(messagesPerSession) || 20,
      totalMessagesTarget,
      status: 'draft',
      stats: {
        totalSent: 0,
        totalFailed: 0,
        progressPercent: 0,
      },
      logs: [],
    });

    await task.save();
    return task;
  }

  /**
   * List all warmer tasks for a user
   */
  async listTasks(userId) {
    return await WarmerTask.find({ userId })
      .select('-logs') // omit logs in list view for performance
      .sort({ createdAt: -1 })
      .lean();
  }

  /**
   * Get single task with latest logs
   */
  async getTask(userId, taskId) {
    const task = await WarmerTask.findOne({ _id: taskId, userId }).lean();
    if (!task) throw new Error('Warmup task not found');
    return task;
  }

  /**
   * Helper to cancel all active timers for a task
   */
  clearAllTaskTimers(taskIdStr) {
    if (this.activeTasks.has(taskIdStr)) {
      const laneTimers = this.activeTasks.get(taskIdStr);
      for (const timer of laneTimers.values()) {
        clearTimeout(timer);
      }
      this.activeTasks.delete(taskIdStr);
    }
  }

  /**
   * Start or resume warmer task with simultaneous concurrent pair processes
   */
  async startTask(userId, taskId) {
    const task = await WarmerTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Warmup task not found');

    if (task.status === 'completed') {
      throw new Error('This warmup task has already reached its target. Please reset or create a new task.');
    }

    if (task.participatingSessions.length < 2) {
      throw new Error('Warmup requires at least 2 connected WhatsApp sessions.');
    }

    task.status = 'running';
    task.lastError = '';
    await task.save();

    const taskIdStr = task._id.toString();
    this.clearAllTaskTimers(taskIdStr);

    // Generate round-robin tournament rounds
    const rounds = this.generateRoundRobinRounds(task.participatingSessions);
    if (!rounds || rounds.length === 0) {
      throw new Error('Could not form valid conversation pairs.');
    }

    // Number of simultaneous pair lanes = pairs in round 0
    const initialPairs = rounds[0];
    const numLanes = initialPairs.length;

    // Initialize lane states
    let taskLaneStates = this.taskStates.get(taskIdStr);
    if (!taskLaneStates) {
      taskLaneStates = new Map();
      this.taskStates.set(taskIdStr, taskLaneStates);
    }

    const activePairSummary = [];
    const laneTimersMap = new Map();
    this.activeTasks.set(taskIdStr, laneTimersMap);

    this.emitToUser(userId, 'warmer:task_status', {
      taskId: task._id,
      status: 'running',
      stats: task.stats,
    });

    // Launch each simultaneous pair process with slight initial stagger (e.g. 1s apart)
    for (let laneIndex = 0; laneIndex < numLanes; laneIndex++) {
      if (!taskLaneStates.has(laneIndex)) {
        taskLaneStates.set(laneIndex, {
          dialogueIndex: 0,
          roundIndex: 0,
        });
      }

      const initialPair = rounds[0][laneIndex];
      if (initialPair) {
        activePairSummary.push({
          laneIndex,
          pairLabel: `Pair ${laneIndex + 1}`,
          accA: initialPair[0],
          accB: initialPair[1],
        });
      }

      const initialStaggerMs = 1500 + laneIndex * 2500; // stagger start so initial messages are distributed
      const timer = setTimeout(() => {
        this.executePairLaneStep(taskIdStr, userId, laneIndex);
      }, initialStaggerMs);

      laneTimersMap.set(laneIndex, timer);
    }

    console.log(`[WARMER] Started task "${task.name}" with ${numLanes} simultaneous pair processes.`);
    return task;
  }

  /**
   * Stop / Pause warmer task
   */
  async stopTask(userId, taskId) {
    const task = await WarmerTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Warmup task not found');

    task.status = 'paused';
    await task.save();

    const tId = taskId.toString();
    this.clearAllTaskTimers(tId);

    this.emitToUser(userId, 'warmer:task_status', {
      taskId: task._id,
      status: 'paused',
      stats: task.stats,
    });

    return task;
  }

  /**
   * Reset stats and logs of task
   */
  async resetTask(userId, taskId) {
    const task = await WarmerTask.findOne({ _id: taskId, userId });
    if (!task) throw new Error('Warmup task not found');

    const tId = taskId.toString();
    this.clearAllTaskTimers(tId);
    this.taskStates.delete(tId);

    task.status = 'draft';
    task.stats = { totalSent: 0, totalFailed: 0, progressPercent: 0 };
    task.logs = [];
    task.lastError = '';
    await task.save();

    this.emitToUser(userId, 'warmer:task_status', {
      taskId: task._id,
      status: 'draft',
      stats: task.stats,
    });

    return task;
  }

  /**
   * Delete warmer task
   */
  async deleteTask(userId, taskId) {
    const tId = taskId.toString();
    this.clearAllTaskTimers(tId);
    this.taskStates.delete(tId);

    const result = await WarmerTask.findOneAndDelete({ _id: taskId, userId });
    if (!result) throw new Error('Warmup task not found');
    return { success: true, message: 'Warmup task deleted successfully' };
  }

  /**
   * Execute 1 auto-chat exchange for a specific simultaneous pair lane (e.g. Lane 0 = Pair 1, Lane 1 = Pair 2)
   */
  async executePairLaneStep(taskIdStr, userId, laneIndex) {
    try {
      const task = await WarmerTask.findOne({ _id: taskIdStr, userId });
      if (!task || task.status !== 'running') {
        this.clearAllTaskTimers(taskIdStr);
        return;
      }

      // Check if global target already reached
      if (task.stats.totalSent >= task.totalMessagesTarget) {
        task.status = 'completed';
        task.stats.progressPercent = 100;
        await task.save();

        this.clearAllTaskTimers(taskIdStr);
        this.emitToUser(userId, 'warmer:task_completed', {
          taskId: task._id,
          stats: task.stats,
        });
        return;
      }

      const sessions = task.participatingSessions || [];
      if (sessions.length < 2) {
        task.status = 'failed';
        task.lastError = 'Requires at least 2 sessions.';
        await task.save();
        this.clearAllTaskTimers(taskIdStr);
        return;
      }

      const rounds = this.generateRoundRobinRounds(sessions);
      if (rounds.length === 0) {
        task.status = 'failed';
        task.lastError = 'No valid round robin pairs could be generated.';
        await task.save();
        this.clearAllTaskTimers(taskIdStr);
        return;
      }

      // Retrieve lane state
      let taskLaneStates = this.taskStates.get(taskIdStr);
      if (!taskLaneStates) {
        taskLaneStates = new Map();
        this.taskStates.set(taskIdStr, taskLaneStates);
      }

      let laneState = taskLaneStates.get(laneIndex) || {
        dialogueIndex: 0,
        roundIndex: 0,
      };

      const currentRoundPairs = rounds[laneState.roundIndex % rounds.length] || rounds[0];
      const currentPair = currentRoundPairs[laneIndex % currentRoundPairs.length];

      if (!currentPair || currentPair.length < 2) {
        console.warn(`[WARMER] Lane ${laneIndex} has no active pair in round ${laneState.roundIndex}`);
        // Advance round
        laneState.roundIndex = (laneState.roundIndex + 1) % rounds.length;
        taskLaneStates.set(laneIndex, laneState);
        this.scheduleNextLaneStep(taskIdStr, userId, laneIndex, task);
        return;
      }

      const [accA, accB] = currentPair;
      const dialogueList = this.getDialoguesForTask(task);

      // Strict alternation between Account A and Account B in this pair
      // Turn 0 (even): A -> B
      // Turn 1 (odd):  B -> A
      const isTurnA = laneState.dialogueIndex % 2 === 0;
      const sender = isTurnA ? accA : accB;
      const receiver = isTurnA ? accB : accA;

      const messageText =
        dialogueList[laneState.dialogueIndex % dialogueList.length] || 'Hey there! How is everything going?';

      const pairLabel = `Pair ${laneIndex + 1}`;

      // Calculate next turn state for this lane
      let nextDialogueIndex = laneState.dialogueIndex + 1;
      let nextRoundIndex = laneState.roundIndex;

      // When conversation script finishes a full dialogue thread (or 6 messages), rotate to next round's pair
      if (nextDialogueIndex >= Math.min(dialogueList.length, 8)) {
        nextDialogueIndex = 0;
        nextRoundIndex = (laneState.roundIndex + 1) % rounds.length;
      }

      taskLaneStates.set(laneIndex, {
        dialogueIndex: nextDialogueIndex,
        roundIndex: nextRoundIndex,
      });

      // Refresh receiver phone number if needed
      let targetPhone = receiver.phoneNumber;
      if (!targetPhone) {
        const sessObj = await WhatsAppSession.findOne({ sessionId: receiver.sessionId, userId });
        targetPhone = sessObj?.phoneNumber || sessObj?.me?.id?.split(':')[0]?.split('@')[0];
      }

      if (!targetPhone) {
        console.warn(`[WARMER] Receiver ${receiver.sessionId} has no valid phone number.`);
        this.scheduleNextLaneStep(taskIdStr, userId, laneIndex, task);
        return;
      }

      // Attempt to send WhatsApp message
      let isSuccess = false;
      let sendErrorMsg = '';

      try {
        await WhatsAppService.sendMessage(sender.sessionId, targetPhone, messageText);
        isSuccess = true;
      } catch (err) {
        console.error(`[WARMER Lane ${laneIndex}] Send failed from ${sender.sessionId} to ${targetPhone}:`, err.message);
        sendErrorMsg = err.message || 'WhatsApp sending failed';
      }

      const logEntry = {
        pairLabel,
        pairIndex: laneIndex,
        fromSessionId: sender.sessionId,
        fromName: sender.name || sender.sessionId,
        fromPhone: sender.phoneNumber || '',
        toSessionId: receiver.sessionId,
        toName: receiver.name || receiver.sessionId,
        toPhone: targetPhone,
        message: messageText,
        status: isSuccess ? 'sent' : 'failed',
        sentAt: new Date(),
        error: sendErrorMsg,
      };

      // Atomic update in MongoDB to prevent race conditions across parallel lanes
      const updateDoc = {
        $inc: {
          'stats.totalSent': isSuccess ? 1 : 0,
          'stats.totalFailed': isSuccess ? 0 : 1,
        },
        $push: {
          logs: {
            $each: [logEntry],
            $slice: -500, // Keep last 500 logs
          },
        },
      };

      if (!isSuccess) {
        updateDoc.$set = { lastError: sendErrorMsg };
      }

      const updatedTask = await WarmerTask.findOneAndUpdate(
        { _id: taskIdStr, userId },
        updateDoc,
        { new: true }
      );

      if (!updatedTask) return;

      // Calculate progress
      const currentSent = updatedTask.stats?.totalSent || 0;
      const progressPercent = Math.min(
        100,
        Math.round((currentSent / Math.max(1, updatedTask.totalMessagesTarget)) * 100)
      );

      updatedTask.stats.progressPercent = progressPercent;

      // Check if task completed after this send
      if (currentSent >= updatedTask.totalMessagesTarget) {
        updatedTask.status = 'completed';
        await updatedTask.save();

        this.clearAllTaskTimers(taskIdStr);
        this.emitToUser(userId, 'warmer:task_completed', {
          taskId: updatedTask._id,
          stats: updatedTask.stats,
        });
        return;
      }

      // Save progress update
      await WarmerTask.updateOne(
        { _id: taskIdStr },
        { $set: { 'stats.progressPercent': progressPercent } }
      );

      // Emit real-time message event with pair information to all open browser sessions
      this.emitToUser(userId, 'warmer:message_sent', {
        taskId: updatedTask._id,
        pairIndex: laneIndex,
        pairLabel,
        log: logEntry,
        stats: {
          ...updatedTask.stats,
          progressPercent,
        },
        status: updatedTask.status,
      });

      // Schedule next message for this specific lane if still running
      if (updatedTask.status === 'running') {
        this.scheduleNextLaneStep(taskIdStr, userId, laneIndex, updatedTask);
      }
    } catch (error) {
      console.error(`[WARMER Lane ${laneIndex}] Step execution error:`, error);
      // Try to re-schedule next step after brief cooldown
      setTimeout(() => {
        this.scheduleNextLaneStep(taskIdStr, userId, laneIndex, { minDelaySeconds: 20, maxDelaySeconds: 40 });
      }, 10000);
    }
  }

  /**
   * Schedule the next step for a specific pair lane with randomized jitter delay
   */
  scheduleNextLaneStep(taskIdStr, userId, laneIndex, taskConfig) {
    if (!this.activeTasks.has(taskIdStr)) {
      return;
    }

    const laneTimersMap = this.activeTasks.get(taskIdStr);
    if (laneTimersMap.has(laneIndex)) {
      clearTimeout(laneTimersMap.get(laneIndex));
      laneTimersMap.delete(laneIndex);
    }

    const minD = Math.max(5, taskConfig.minDelaySeconds || 15);
    const maxD = Math.max(minD, taskConfig.maxDelaySeconds || 45);
    const randomSeconds = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
    const delayMs = randomSeconds * 1000;

    const timer = setTimeout(() => {
      this.executePairLaneStep(taskIdStr, userId, laneIndex);
    }, delayMs);

    laneTimersMap.set(laneIndex, timer);
  }
}

const warmerServiceInstance = new WarmerService();
export default warmerServiceInstance;
