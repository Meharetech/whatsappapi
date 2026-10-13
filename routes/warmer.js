import express from 'express';
import authMiddleware from '../middleware/auth.js';
import {
  createWarmerTask,
  getWarmerTasks,
  getWarmerTaskById,
  startWarmerTask,
  stopWarmerTask,
  resetWarmerTask,
  deleteWarmerTask,
} from '../controllers/warmerController.js';

const router = express.Router();

router.use(authMiddleware);

router.post('/', createWarmerTask);
router.get('/', getWarmerTasks);
router.get('/:id', getWarmerTaskById);
router.post('/:id/start', startWarmerTask);
router.post('/:id/stop', stopWarmerTask);
router.post('/:id/reset', resetWarmerTask);
router.delete('/:id', deleteWarmerTask);

export default router;
