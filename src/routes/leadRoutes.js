import express from 'express';
import {
  getLeads,
  createLead,
  getLeadStats,
  getAllCombinedLeads,
  getAllCombinedLeadsPaged,
  getUnifiedLead,
  getUnifiedLeadActivity,
  updateLeadNotificationPreferences,
  updateLeadStatus,
  updateLeadFollowUp,
  addLeadComment,
  assignLead,
  bulkAssignLeads,
  getAssignableLeadUsers,
  startLeadCall,
  getLeadCallLogs,
  updateCallManualComment,
  callCompletedWebhook,
} from '../controllers/leadController.js';
import {
  sendLeadEmail,
  sendLeadWhatsApp,
} from '../controllers/leadMessageController.js';
import { enrichUrl } from '../controllers/extractController.js';
import { upload } from '../middleware/uploadMiddleware.js';
import { protect } from '../middleware/authMiddleware.js';
import { requirePermission } from '../middleware/permissionMiddleware.js';
import { PERMISSIONS } from '../constants/permissions.js';

const router = express.Router();

router.post(
  '/enrich-url',
  protect,
  requirePermission(PERMISSIONS.LEADS_CREATE),
  enrichUrl,
);

router.route('/stats')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getLeadStats);

router.route('/all/paged')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getAllCombinedLeadsPaged);

router.route('/all')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getAllCombinedLeads);

router.route('/assignable-users')
  .get(protect, requirePermission(PERMISSIONS.LEADS_ASSIGN), getAssignableLeadUsers);

router.route('/bulk-assign')
  .put(protect, requirePermission(PERMISSIONS.LEADS_ASSIGN), bulkAssignLeads);

router.route('/webhooks/call-completed')
  .post(callCompletedWebhook);

router.route('/calls/:callLogId/comment')
  .put(protect, requirePermission(PERMISSIONS.CALLS_MANAGE), updateCallManualComment);

router.route('/unified/:type/:id')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getUnifiedLead);

router.route('/unified/:type/:id/activity')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getUnifiedLeadActivity);

router.route('/unified/:type/:id/call')
  .post(protect, requirePermission(PERMISSIONS.CALLS_MANAGE), startLeadCall);

router.route('/unified/:type/:id/calls')
  .get(protect, requirePermission(PERMISSIONS.CALLS_VIEW), getLeadCallLogs);

router.route('/unified/:type/:id/status')
  .put(protect, requirePermission(PERMISSIONS.LEADS_CHANGE_STATUS), updateLeadStatus);

router.route('/unified/:type/:id/notification-preferences')
  .patch(
    protect,
    requirePermission(PERMISSIONS.LEADS_MANAGE_NOTIFICATIONS),
    updateLeadNotificationPreferences,
  );

router.route('/unified/:type/:id/follow-up')
  .put(protect, requirePermission(PERMISSIONS.LEADS_CHANGE_STATUS), updateLeadFollowUp);

router.route('/unified/:type/:id/comment')
  .post(protect, requirePermission(PERMISSIONS.LEADS_ADD_NOTE), upload.single('attachment'), addLeadComment);

router.post(
  '/unified/:type/:id/messages/email',
  protect,
  requirePermission(PERMISSIONS.LEADS_VIEW),
  requirePermission(PERMISSIONS.EMAIL_TEMPLATES_USE),
  requirePermission(PERMISSIONS.EMAIL_SEND_LEAD),
  sendLeadEmail,
);

router.post(
  '/unified/:type/:id/messages/whatsapp',
  protect,
  requirePermission(PERMISSIONS.LEADS_VIEW),
  requirePermission(PERMISSIONS.WHATSAPP_TEMPLATES_USE),
  requirePermission(PERMISSIONS.WHATSAPP_SEND_LEAD),
  sendLeadWhatsApp,
);

router.route('/unified/:type/:id/assign')
  .put(protect, requirePermission(PERMISSIONS.LEADS_ASSIGN), assignLead);

router.route('/')
  .get(protect, requirePermission(PERMISSIONS.LEADS_VIEW), getLeads)
  .post(protect, requirePermission(PERMISSIONS.LEADS_CREATE), createLead);

export default router;
