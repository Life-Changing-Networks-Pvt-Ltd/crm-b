import express from 'express';
import {
  getIndiaMartConfig,
  saveIndiaMartConfig,
  triggerIndiaMartSync,
  disconnectIndiaMart,
} from '../controllers/integrationController.js';
import { protect } from '../middleware/authMiddleware.js';

const router = express.Router();

router.use(protect);

router.route('/indiamart')
  .get(getIndiaMartConfig)
  .post(saveIndiaMartConfig)
  .delete(disconnectIndiaMart);

router.post('/indiamart/sync', triggerIndiaMartSync);

export default router;
