import express from 'express';
import numberListController from '../controllers/numberListController.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

router.get('/', authMiddleware, numberListController.getLists);
router.post('/', authMiddleware, numberListController.createList);
router.post('/merge', authMiddleware, numberListController.mergeLists);
router.get('/:id', authMiddleware, numberListController.getList);
router.put('/:id', authMiddleware, numberListController.updateList);
router.delete('/:id', authMiddleware, numberListController.deleteList);
router.post('/:id/duplicate', authMiddleware, numberListController.duplicateList);
router.post('/:id/filter', authMiddleware, numberListController.filterList);

export default router;
