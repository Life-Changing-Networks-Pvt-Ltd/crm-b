import express from 'express';
import { getTasks, getTasksPaged, createTask, updateTask, deleteTask } from '../controllers/taskController.js';
import { protect } from '../middleware/authMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import { PERMISSIONS } from '../constants/permissions.js';

const router = express.Router();

router.get('/paged', protect, requirePermission(PERMISSIONS.TASKS_VIEW), getTasksPaged);

router.route('/')
  .get(protect, requirePermission(PERMISSIONS.TASKS_VIEW), getTasks)
  .post(protect, requirePermission(PERMISSIONS.TASKS_CREATE), createTask);

router.route('/:id')
  .put(
    protect,
    requirePermission(
      PERMISSIONS.TASKS_VIEW,
      PERMISSIONS.TASKS_EDIT,
      PERMISSIONS.TASKS_ASSIGN,
      PERMISSIONS.TASKS_REVIEW,
    ),
    updateTask,
  )
  .delete(protect, requirePermission(PERMISSIONS.TASKS_DELETE), deleteTask);

export default router;
