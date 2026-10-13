import WhatsAppService from '../services/WhatsAppService.js';
import WhatsAppSession from '../models/WhatsAppSession.js';
import NumberList from '../models/NumberList.js';
import ValidatorTaskService from '../services/ValidatorTaskService.js';
import SubscriptionService from '../services/SubscriptionService.js';
import { sendSubscriptionError } from '../utils/subscription.js';

/**
 * Helper to normalize phone digits and format with country code
 */
const cleanPhoneNumber = (rawNumber, defaultCountryCode = '91') => {
  if (!rawNumber) return null;
  const rawStr = String(rawNumber).trim();
  const digits = rawStr.replace(/\D/g, '');
  if (!digits) return null;

  const defaultCc = String(defaultCountryCode || '91').replace(/\D/g, '');

  let normalized = digits;
  if (digits.length === 10) {
    normalized = `${defaultCc}${digits}`;
  }

  return {
    raw: rawStr,
    digits: normalized,
    formatted: `+${normalized}`,
    jid: `${normalized}@s.whatsapp.net`,
  };
};

/**
 * Check a list of phone numbers against WhatsApp in real-time batches
 */
export const checkWhatsAppNumbers = async (req, res) => {
  try {
    const {
      sessionId,
      sessionIds,
      numbers = [],
      defaultCountryCode = '91',
      batchSize = 20,
      delayMs = 1500,
    } = req.body;

    const candidateSessionIds = Array.isArray(sessionIds) && sessionIds.length > 0
      ? sessionIds
      : (sessionId ? [sessionId] : []);

    if (candidateSessionIds.length === 0) {
      return res.status(400).json({ error: 'Connected WhatsApp session ID is required' });
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'Please provide at least one phone number to validate' });
    }

    // Verify session ownership & active connections
    const validSockets = [];
    for (const sId of candidateSessionIds) {
      const session = await WhatsAppSession.findOne({
        sessionId: sId,
        userId: req.user._id,
      });

      if (session) {
        const sock = WhatsAppService.sockets.get(sId);
        if (sock && WhatsAppService.isSocketOpen(sock)) {
          validSockets.push({ sessionId: sId, sock });
        }
      }
    }

    if (validSockets.length === 0) {
      return res.status(400).json({
        error: 'None of the selected WhatsApp devices are currently connected. Please ensure your device is connected in Devices.',
      });
    }

    // Parse and normalize all input numbers
    const parsedList = [];
    const seenDigits = new Set();

    for (const raw of numbers) {
      const parsed = cleanPhoneNumber(raw, defaultCountryCode);
      if (parsed && !seenDigits.has(parsed.digits)) {
        seenDigits.add(parsed.digits);
        parsedList.push(parsed);
      }
    }

    if (parsedList.length === 0) {
      return res.status(400).json({ error: 'No valid phone digits found in the provided list' });
    }

    // Configurable chunk size and safety delay
    const CHUNK_SIZE = Math.max(1, Math.min(Number(batchSize) || 20, 50));
    const delay = Math.max(100, Math.min(Number(delayMs) || 1500, 10000));
    const finalResults = [];

    for (let i = 0; i < parsedList.length; i += CHUNK_SIZE) {
      const chunk = parsedList.slice(i, i + CHUNK_SIZE);
      const jids = chunk.map((c) => c.jid);

      // Rotate socket round-robin wise across valid devices
      const activeObj = validSockets[Math.floor(i / CHUNK_SIZE) % validSockets.length];
      const sock = activeObj.sock;

      try {
        const waResults = await sock.onWhatsApp(...jids);
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

        for (const item of chunk) {
          const matchedJid = validMap.get(item.digits);
          const isValid = !!matchedJid;

          finalResults.push({
            phone: item.formatted,
            raw: item.raw,
            digits: item.digits,
            jid: matchedJid || item.jid,
            isValid,
            status: isValid ? 'valid' : 'invalid',
          });
        }
      } catch (chunkErr) {
        console.warn('[VALIDATOR CHUNK ERROR]', chunkErr.message);
        // If onWhatsApp failed for this chunk, mark as unverified/invalid fallback
        for (const item of chunk) {
          finalResults.push({
            phone: item.formatted,
            raw: item.raw,
            digits: item.digits,
            jid: item.jid,
            isValid: false,
            status: 'invalid',
            error: chunkErr.message,
          });
        }
      }

      // Precaution delay between batches to protect WhatsApp socket
      if (i + CHUNK_SIZE < parsedList.length) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const validCount = finalResults.filter((r) => r.isValid).length;
    const invalidCount = finalResults.length - validCount;

    return res.json({
      success: true,
      total: finalResults.length,
      validCount,
      invalidCount,
      results: finalResults,
    });
  } catch (err) {
    console.error('[VALIDATOR ERROR]', err);
    return res.status(500).json({ error: err.message || 'Validation failed' });
  }
};

/**
 * Save valid numbers directly into a new NumberList
 */
export const saveValidatedList = async (req, res) => {
  try {
    const { name, numbers = [], tags = ['validated'], color = 'bg-emerald-500' } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'List name is required' });
    }

    if (!Array.isArray(numbers) || numbers.length === 0) {
      return res.status(400).json({ error: 'No phone numbers to save' });
    }

    await SubscriptionService.assertResourceLimit(req.user, 'numberLists', 1);

    const cleanNumbers = [...new Set(numbers.map((n) => String(n).trim()).filter(Boolean))];

    const newList = await NumberList.create({
      userId: req.user._id,
      name: name.trim(),
      numbers: cleanNumbers,
      tags: Array.isArray(tags) ? tags : ['validated'],
      color: color || 'bg-emerald-500',
    });

    return res.status(201).json({
      success: true,
      message: 'Validated list saved successfully',
      list: {
        id: newList._id.toString(),
        name: newList.name,
        count: newList.numbers.length,
        numbers: newList.numbers,
        tags: newList.tags,
        color: newList.color,
        created: newList.createdAt ? newList.createdAt.toISOString().slice(0, 10) : null,
      },
    });
  } catch (err) {
    return sendSubscriptionError(res, err, 'Failed to save validated list');
  }
};

/**
 * Clean an existing contact list by removing all invalid numbers
 */
export const cleanExistingList = async (req, res) => {
  try {
    const { id } = req.params;
    const { validNumbers = [] } = req.body;

    const list = await NumberList.findOne({
      _id: id,
      userId: req.user._id,
    });

    if (!list) {
      return res.status(404).json({ error: 'Contact list not found' });
    }

    const originalCount = list.numbers.length;
    const cleanNumbers = [...new Set(validNumbers.map((n) => String(n).trim()).filter(Boolean))];

    list.numbers = cleanNumbers;
    if (!list.tags.includes('verified')) {
      list.tags.push('verified');
    }
    await list.save();

    return res.json({
      success: true,
      message: `Cleaned list: removed ${originalCount - cleanNumbers.length} invalid numbers`,
      removedCount: originalCount - cleanNumbers.length,
      remainingCount: cleanNumbers.length,
      list: {
        id: list._id.toString(),
        name: list.name,
        count: list.numbers.length,
        numbers: list.numbers,
        tags: list.tags,
        color: list.color,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to clean list' });
  }
};

/**
 * Create and start a background validation task
 */
export const createTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.createTask(req.user._id, req.body);
    return res.status(201).json({ success: true, task });
  } catch (err) {
    console.error('[createTask ERROR]', err);
    return res.status(400).json({ error: err.message || 'Failed to create validation task' });
  }
};

/**
 * List all validation tasks for the authenticated user
 */
export const listTasks = async (req, res) => {
  try {
    const tasks = await ValidatorTaskService.listTasks(req.user._id);
    return res.json({ success: true, tasks });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to list validation tasks' });
  }
};

/**
 * Get active (running or paused) task for user, or latest task
 */
export const getActiveTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.getActiveTask(req.user._id);
    return res.json({ success: true, task: task || null });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Failed to get active task' });
  }
};

/**
 * Get single task by ID (full data)
 */
export const getTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.getTask(req.user._id, req.params.id);
    return res.json({ success: true, task });
  } catch (err) {
    return res.status(404).json({ error: err.message || 'Task not found' });
  }
};

/**
 * Ultra-lightweight delta progress query for high-frequency polling
 */
export const getTaskProgress = async (req, res) => {
  try {
    const progress = await ValidatorTaskService.getTaskProgress(req.user._id, req.params.id);
    return res.json({ success: true, progress });
  } catch (err) {
    return res.status(404).json({ error: err.message || 'Task not found' });
  }
};

/**
 * Pause a running task
 */
export const pauseTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.pauseTask(req.user._id, req.params.id);
    return res.json({ success: true, task });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to pause task' });
  }
};

/**
 * Resume a paused task
 */
export const resumeTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.resumeTask(req.user._id, req.params.id);
    return res.json({ success: true, task });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to resume task' });
  }
};

/**
 * Stop / abort a running task
 */
export const stopTask = async (req, res) => {
  try {
    const task = await ValidatorTaskService.stopTask(req.user._id, req.params.id);
    return res.json({ success: true, task });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to stop task' });
  }
};

/**
 * Delete a task
 */
export const deleteTask = async (req, res) => {
  try {
    await ValidatorTaskService.deleteTask(req.user._id, req.params.id);
    return res.json({ success: true, message: 'Task deleted successfully' });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Failed to delete task' });
  }
};

/**
 * Save valid numbers from a task into a new NumberList
 */
export const saveTaskToContactList = async (req, res) => {
  try {
    const { name } = req.body;
    const list = await ValidatorTaskService.saveToContactList(req.user._id, req.params.id, name);
    return res.status(201).json({
      success: true,
      message: 'Validated contacts saved to list',
      list,
    });
  } catch (err) {
    return sendSubscriptionError(res, err, 'Failed to save validated list');
  }
};

export default {
  checkWhatsAppNumbers,
  saveValidatedList,
  cleanExistingList,
  createTask,
  listTasks,
  getActiveTask,
  getTask,
  getTaskProgress,
  pauseTask,
  resumeTask,
  stopTask,
  deleteTask,
  saveTaskToContactList,
};

