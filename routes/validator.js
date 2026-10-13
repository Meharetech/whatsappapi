import express from 'express';
import validatorController from '../controllers/validatorController.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Check an array of phone numbers on WhatsApp (instant check)
router.post('/check', authMiddleware, validatorController.checkWhatsAppNumbers);

// Save valid numbers into a new NumberList
router.post('/save-list', authMiddleware, validatorController.saveValidatedList);

// Clean an existing NumberList by removing invalid numbers
router.post('/clean-list/:id', authMiddleware, validatorController.cleanExistingList);

// ── Persistent Background Task Routes ──
// Create and launch background validation task
router.post('/tasks', authMiddleware, validatorController.createTask);

// List user validation tasks (history)
router.get('/tasks', authMiddleware, validatorController.listTasks);

// Get currently active (running or paused) task
router.get('/tasks/active', authMiddleware, validatorController.getActiveTask);

// Get single task lightweight progress (for 60fps fast live polling without lagging)
router.get('/tasks/:id/progress', authMiddleware, validatorController.getTaskProgress);

// Get single task by ID (with all numbers)
router.get('/tasks/:id', authMiddleware, validatorController.getTask);

// Pause a running task
router.post('/tasks/:id/pause', authMiddleware, validatorController.pauseTask);

// Resume a paused task
router.post('/tasks/:id/resume', authMiddleware, validatorController.resumeTask);

// Stop / abort a running task
router.post('/tasks/:id/stop', authMiddleware, validatorController.stopTask);

// Delete a task
router.delete('/tasks/:id', authMiddleware, validatorController.deleteTask);

// Save valid numbers from a task into a Contact List
router.post('/tasks/:id/save-list', authMiddleware, validatorController.saveTaskToContactList);

export default router;

