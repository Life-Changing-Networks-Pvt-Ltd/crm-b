import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import Company from '../models/Company.js';
import Notification from '../models/Notification.js';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import CallLog from '../models/CallLog.js';
import LeadStatusHistory from '../models/LeadStatusHistory.js';
import FollowUp from '../models/FollowUp.js';
import { syncDemoFollowUpReminder } from '../services/demoFollowUpReminderService.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { getDownlineUserIds, isAdminUser } from '../utils/hierarchy.js';
import { logActivity } from '../utils/activity.js';
import { createPlivoBridge, prepareBrowserCall } from './telephonyController.js';
import { normalizePhone } from '../services/plivoService.js';
import { saveCallbackRoute } from '../services/callbackRoutingService.js';
import { selectNextCallingNumber } from '../services/callingNumberPoolService.js';
import { getCachedLeadStats } from '../services/leadStatsService.js';
import { invalidateLeadMetricsCaches } from '../services/cacheService.js';
import { escapeRegex, pagedData, paginationMeta, parsePagination } from '../services/listQueryService.js';
import { parseLeadStatusDate } from '../utils/leadStatusDate.js';
import { parseFollowUpPayload } from '../utils/followUp.js';
import { parseStatusDetails } from '../utils/statusDetails.js';
import { cancelFollowUpReminder } from '../services/followUpReminderService.js';
import { resolveLeadVisibility } from '../services/leadAccessService.js';
import { resolveEffectiveAccessMany, userHasPermission } from '../services/accessControlService.js';
import { PERMISSIONS } from '../constants/permissions.js';
import LeadMessage from '../models/LeadMessage.js';
import ActivityLog from '../models/ActivityLog.js';
import { sendAutomatedLeadStatusNotifications } from '../services/leadStatusNotificationService.js';

const STATUS_ALIASES = {
  demo_scheduled: 'Demo Scheduled',
  demo_follow_up: 'Demo follow-up',
  'demo follow-up': 'Demo follow-up',
  followup: 'Follow Up',
  follow_up: 'Follow Up',
  committed: 'Committed',
  converted: 'Converted',
  not_interested: 'Not Interested',
};

const LEAD_STATUSES = new Set([
  'New',
  'Demo Scheduled',
  'Demo follow-up',
  'Interested',
  'Not Interested',
  'Follow Up',
  'Committed',
  'Converted',
]);

const normalizeStatus = (status) => STATUS_ALIASES[status?.toString().trim().toLowerCase()] || status;

const getLeadModel = (type) => {
  if (type === 'Customer') return Customer;
  if (type === 'Company') return Company;
  if (type === 'Lead') return Lead;
  return null;
};

const getLeadStatusField = (type) => (type === 'Lead' ? 'status' : 'leadStatus');

const getLeadName = (lead) => lead.companyName || lead.name || lead.customerName || 'lead';

const normalizeAssignees = (assignedTo) => {
  if (!assignedTo) return [];
  return Array.isArray(assignedTo) ? assignedTo.filter(Boolean) : [assignedTo];
};

const assigneeNames = (assignedTo) => {
  const assignees = normalizeAssignees(assignedTo);
  if (assignees.length === 0) return '---';
  return assignees.map((user) => user?.name || 'Unknown').join(', ');
};

const ensureAssigneeArray = async (Model, lead) => {
  await Model.updateOne(
    { _id: lead._id },
    { $set: { assignedTo: normalizeAssignees(lead.assignedTo) } }
  );
};

const usersWithLeadAccess = async (users) => {
  const accessRows = await resolveEffectiveAccessMany(users);
  return users
    .filter((candidate, index) => userHasPermission(accessRows[index], PERMISSIONS.LEADS_VIEW))
    .map((candidate) => candidate._id);
};

const getAssignableUserIds = async (user) => {
  if (isAdminUser(user)) {
    const users = await User.find({
      isActive: true,
      _id: { $ne: user._id },
    })
      .select('_id role roleRef teams permissionOverrides scopeOverrides isActive')
      .lean();
    return usersWithLeadAccess(users);
  }

  const downlineIds = await getDownlineUserIds(user._id);
  const managedEmployees = await Employee.find({ manager: user._id, status: { $ne: 'Inactive' } })
    .select('email')
    .lean();
  const managedEmployeeEmails = managedEmployees.map((employee) => employee.email).filter(Boolean);
  const users = await User.find({
    $or: [
      { _id: { $in: downlineIds.filter((id) => id.toString() !== user._id.toString()) } },
      { email: { $in: managedEmployeeEmails } },
    ],
    isActive: true,
  })
    .select('_id role roleRef teams permissionOverrides scopeOverrides isActive')
    .lean();

  return usersWithLeadAccess(users);
};

const getVisibleAssigneeIds = async (user) => {
  if (isAdminUser(user)) {
    const users = await User.find({ isActive: true }).select('_id').lean();
    return users.map((item) => item._id);
  }

  const downlineIds = await getDownlineUserIds(user._id);
  return downlineIds;
};

const assertCanAssignToUser = async (user, assignedTo) => {
  if (!assignedTo) return false;
  const assignableIds = await getAssignableUserIds(user);
  return assignableIds.some((id) => id.toString() === assignedTo.toString());
};

const findUnifiedLeadForUser = async (type, id, user, populate = false) => {
  const Model = getLeadModel(type);
  if (!Model) return null;

  const visibility = await resolveLeadVisibility(user);
  const query = { _id: id, ...visibility.query };

  let dbQuery = Model.findOne(query);
  if (populate) {
    dbQuery = dbQuery
      .populate('createdBy', 'name role email')
      .populate('assignedTo', 'name role email')
      .populate('comments.createdBy', 'name');
    if (Model === Company) {
      dbQuery = dbQuery.populate('statusDetails.savedBy', 'name');
    }
  }

  return dbQuery;
};

const analyzeTranscript = (transcriptText = '') => {
  const transcript = transcriptText.trim();
  if (!transcript) {
    return {
      aiSummary: 'Recording received. Transcript is not available yet.',
      aiQualityScore: 5,
      aiSentiment: 'neutral',
      aiSuggestion: 'Add manual notes after reviewing the recording.',
      keyPoints: [],
    };
  }

  const positiveWords = ['yes', 'interested', 'good', 'demo', 'budget', 'approved', 'buy', 'converted'];
  const negativeWords = ['no', 'not interested', 'expensive', 'later', 'busy', 'reject'];
  const lower = transcript.toLowerCase();
  const positiveScore = positiveWords.filter((word) => lower.includes(word)).length;
  const negativeScore = negativeWords.filter((word) => lower.includes(word)).length;
  const aiSentiment = positiveScore > negativeScore ? 'positive' : negativeScore > positiveScore ? 'negative' : 'neutral';
  const aiQualityScore = Math.max(1, Math.min(10, 5 + positiveScore - negativeScore));

  return {
    aiSummary: transcript.length > 220 ? `${transcript.slice(0, 220)}...` : transcript,
    aiQualityScore,
    aiSentiment,
    aiSuggestion: aiSentiment === 'positive'
      ? 'Schedule the next step quickly and confirm decision maker availability.'
      : aiSentiment === 'negative'
        ? 'Capture the objection, send a concise value proof, and set a low-pressure follow-up.'
        : 'Clarify pain points, timeline, budget, and next action in the next conversation.',
    keyPoints: transcript.split(/[.!?]/).map((item) => item.trim()).filter(Boolean).slice(0, 5),
  };
};

// @desc    Get all leads
// @route   GET /api/leads
// @access  Private
export const getLeads = async (req, res, next) => {
  try {
    const { query } = await resolveLeadVisibility(req.user);

    const leads = await Lead.find(query)
      .populate('createdBy', 'name role email')
      .populate('assignedTo', 'name role email')
      .sort({ createdAt: -1 })
      .lean();
    
    return successResponse(res, 200, 'Leads fetched successfully', leads);
  } catch (error) {
    next(error);
  }
};

// @desc    Get lead statistics
// @route   GET /api/leads/stats
// @access  Private
export const getLeadStats = async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const filters = {
      period: req.query.period || 'today',
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      month: req.query.month,
      year: req.query.year,
      type: req.query.type === 'Company' ? 'Company' : undefined,
    };
    const { value, cacheStatus } = await getCachedLeadStats(req.user, filters);
    const duration = Date.now() - startedAt;
    res.setHeader('Server-Timing', `lead-stats;dur=${duration};desc="cache ${cacheStatus}"`);
    res.setHeader('X-Cache', cacheStatus);
    return successResponse(res, 200, 'Stats fetched', value);
  } catch (error) {
    if (error.statusCode === 400) return errorResponse(res, 400, error.message);
    next(error);
  }
};

// @desc    Get all combined leads (Customers + Companies)
// @route   GET /api/leads/all
// @access  Private
export const getAllCombinedLeads = async (req, res, next) => {
  try {
    const { query } = await resolveLeadVisibility(req.user);

    const [customers, companies] = await Promise.all([
      Customer.find(query).populate('createdBy', 'name').populate('assignedTo', 'name').sort({ createdAt: -1 }).lean(),
      Company.find(query).populate('createdBy', 'name').populate('assignedTo', 'name').sort({ createdAt: -1 }).lean()
    ]);

    const unifiedLeads = [
      ...customers.map(c => ({
        _id: c._id,
        name: c.name,
        email: c.email || '',
        phone: c.phone || '',
        type: 'Customer',
        leadStatus: c.leadStatus || 'New',
        createdBy: c.createdBy?.name || 'System',
        assignedTo: assigneeNames(c.assignedTo),
        commentsCount: c.comments?.length || 0,
        followTypeDate: c.scheduledDateTime || null,
        scheduledDateTime: c.scheduledDateTime || null,
        createdAt: c.createdAt
      })),
      ...companies.map(c => ({
        _id: c._id,
        name: c.companyName,
        email: c.email1 || '',
        phone: c.mobileNo || c.phoneNo || '',
        type: 'Company',
        leadStatus: c.leadStatus || 'New',
        createdBy: c.createdBy?.name || 'System',
        assignedTo: assigneeNames(c.assignedTo),
        commentsCount: c.comments?.length || 0,
        followTypeDate: c.scheduledDateTime || c.followTypeDate,
        scheduledDateTime: c.scheduledDateTime || c.followTypeDate,
        createdAt: c.createdAt
      }))
    ];

    // Sort combined by date descending
    unifiedLeads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return successResponse(res, 200, 'Combined leads fetched', unifiedLeads);
  } catch (error) {
    next(error);
  }
};

// @desc    Get paginated combined leads using a database-side union
// @route   GET /api/leads/all/paged
// @access  Private
export const getAllCombinedLeadsPaged = async (req, res, next) => {
  try {
    const { page, limit, skip, search } = parsePagination(req.query);
    const { query: visibility } = await resolveLeadVisibility(req.user);
    const customerMatch = { ...visibility };
    const companyMatch = { ...visibility };
    const status = req.query.status;
    if (status && status !== 'All') {
      customerMatch.leadStatus = status;
      companyMatch.leadStatus = status;
    }
    if (req.query.followUp === 'upcoming') {
      customerMatch.leadStatus = 'Follow Up';
      companyMatch.leadStatus = 'Follow Up';
    }
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      customerMatch.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }, { company: pattern }];
      companyMatch.$or = [{ companyName: pattern }, { customerName: pattern }, { email1: pattern }, { mobileNo: pattern }];
    }
    const now = new Date();
    let dateStart;
    if (req.query.date === 'Today') {
      dateStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (req.query.date === 'This Week') {
      dateStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    } else if (req.query.date === 'This Month') {
      dateStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    if (dateStart) {
      customerMatch.createdAt = { $gte: dateStart };
      companyMatch.createdAt = { $gte: dateStart };
    }
    const type = req.query.type;
    const customerProjection = {
          name: '$name',
          email: { $ifNull: ['$email', ''] },
          phone: { $ifNull: ['$phone', ''] },
          type: { $literal: 'Customer' },
          leadStatus: { $ifNull: ['$leadStatus', 'New'] },
          followTypeDate: '$scheduledDateTime',
          createdById: '$createdBy',
          assignedToIds: { $ifNull: ['$assignedTo', []] },
          commentsCount: { $size: { $ifNull: ['$comments', []] } },
          createdAt: 1,
    };
    const companyProjection = {
      name: '$companyName',
      email: { $ifNull: ['$email1', ''] },
      phone: { $ifNull: ['$mobileNo', { $ifNull: ['$phoneNo', ''] }] },
      type: { $literal: 'Company' },
      leadStatus: { $ifNull: ['$leadStatus', 'New'] },
      followTypeDate: { $ifNull: ['$scheduledDateTime', '$followTypeDate'] },
      createdById: '$createdBy',
      assignedToIds: { $ifNull: ['$assignedTo', []] },
      commentsCount: { $size: { $ifNull: ['$comments', []] } },
      createdAt: 1,
    };

    const baseModel = type === 'Company' ? Company : Customer;
    const combinedPipeline = type === 'Company'
      ? [{ $match: companyMatch }, { $project: companyProjection }]
      : [{ $match: customerMatch }, { $project: customerProjection }];
    if (!type || (type !== 'Customer' && type !== 'Company')) {
      combinedPipeline.push({
        $unionWith: {
          coll: Company.collection.name,
          pipeline: [
            { $match: companyMatch },
            { $project: companyProjection },
          ],
        },
      });
    }
    combinedPipeline.push({
        $facet: {
          items: [
            { $sort: { createdAt: -1, _id: -1 } },
            { $skip: skip },
            { $limit: limit },
            { $lookup: { from: User.collection.name, localField: 'createdById', foreignField: '_id', as: 'createdByUser' } },
            { $lookup: { from: User.collection.name, localField: 'assignedToIds', foreignField: '_id', as: 'assignedToUsers' } },
            {
              $project: {
                name: 1,
                email: 1,
                phone: 1,
                type: 1,
                leadStatus: 1,
                followTypeDate: 1,
                commentsCount: 1,
                createdAt: 1,
                createdBy: { $ifNull: [{ $arrayElemAt: ['$createdByUser.name', 0] }, 'System'] },
                assignedTo: {
                  $cond: [
                    { $gt: [{ $size: '$assignedToUsers' }, 0] },
                    {
                      $reduce: {
                        input: '$assignedToUsers.name',
                        initialValue: '',
                        in: { $concat: ['$$value', { $cond: [{ $eq: ['$$value', ''] }, '', ', '] }, '$$this'] },
                      },
                    },
                    '---',
                  ],
                },
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
    });

    const result = await baseModel.aggregate(combinedPipeline);

    const items = result[0]?.items || [];
    const total = result[0]?.total[0]?.count || 0;
    return successResponse(res, 200, 'Combined leads page fetched', pagedData(
      items,
      paginationMeta({ page, limit, total }),
    ));
  } catch (error) {
    next(error);
  }
};

// @desc    Get users current user can assign leads to
// @route   GET /api/leads/assignable-users
// @access  Private
export const getAssignableLeadUsers = async (req, res, next) => {
  try {
    const assignableIds = await getAssignableUserIds(req.user);
    const users = await User.find({ _id: { $in: assignableIds }, isActive: true })
      .select('name email role')
      .sort({ name: 1 })
      .lean();

    return successResponse(res, 200, 'Assignable users fetched', users);
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new lead
// @route   POST /api/leads
// @access  Private
export const createLead = async (req, res, next) => {
  try {
    const { name, email, phone, company, status, meetingsCount, designation, address, website, messageNotes, scheduledDateTime, assignedTo } = req.body;
    const finalStatus = scheduledDateTime ? 'Demo Scheduled' : normalizeStatus(status) || 'New';

    const lead = await Lead.create({
      name,
      email,
      phone,
      company,
      designation,
      address,
      website,
      messageNotes,
      scheduledDateTime,
      assignedTo: [assignedTo || req.user._id],
      status: finalStatus,
      meetingsCount: meetingsCount || 0,
      createdBy: req.user._id
    });

    await LeadStatusHistory.create({
      lead: lead._id,
      leadModel: 'Lead',
      oldStatus: null,
      newStatus: finalStatus,
      changedBy: req.user._id,
    });

    await logActivity({
      user: req.user._id,
      actionType: 'lead_created',
      description: `Created lead ${lead.name}`,
      entityType: 'Lead',
      entityId: lead._id,
    });

    await sendAutomatedLeadStatusNotifications({
      leadType: 'Lead',
      lead,
      status: finalStatus,
      actorUserId: req.user._id,
      trigger: 'lead_created',
    });

    const populatedLead = await Lead.findById(lead._id).populate('createdBy', 'name role email').populate('assignedTo', 'name role email');

    await invalidateLeadMetricsCaches();
    return successResponse(res, 201, 'Lead created successfully', populatedLead);
  } catch (error) {
    next(error);
  }
};

// @desc    Get a single unified lead by type and ID
// @route   GET /api/leads/unified/:type/:id
// @access  Private
export const getUnifiedLead = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    let lead;
    
    lead = await findUnifiedLeadForUser(type, id, req.user, true);

    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const [statusHistory, messages] = await Promise.all([
      LeadStatusHistory.find({ lead: id, leadModel: type })
        .populate('changedBy', 'name')
        .populate('call')
        .sort({ changedAt: -1 })
        .limit(200)
        .lean(),
      LeadMessage.find({ lead: id, leadModel: type })
        .populate('createdBy', 'name email')
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
    ]);

    return successResponse(res, 200, 'Lead fetched', {
      ...lead.toObject(),
      statusHistory,
      messages,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update per-lead automatic notification preferences
// @route   PATCH /api/leads/unified/:type/:id/notification-preferences
// @access  Private
export const updateLeadNotificationPreferences = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { channel, enabled } = req.body;
    const Model = getLeadModel(type);
    const preferenceField = channel === 'email'
      ? 'emailEnabled'
      : channel === 'whatsapp' ? 'whatsappEnabled' : null;

    if (!Model || !preferenceField) {
      return errorResponse(res, 400, 'Invalid lead type or notification channel');
    }
    if (typeof enabled !== 'boolean') {
      return errorResponse(res, 400, 'Notification enabled value must be true or false');
    }

    const existingLead = await findUnifiedLeadForUser(type, id, req.user);
    if (!existingLead) return errorResponse(res, 404, 'Lead not found');

    const previousValue = existingLead.notificationPreferences?.[preferenceField] === true;
    const updatedAt = new Date();
    const lead = await Model.findByIdAndUpdate(
      id,
      {
        $set: {
          [`notificationPreferences.${preferenceField}`]: enabled,
          'notificationPreferences.updatedBy': req.user._id,
          'notificationPreferences.updatedAt': updatedAt,
        },
      },
      { new: true, runValidators: true },
    ).populate('notificationPreferences.updatedBy', 'name role email');

    await logActivity({
      user: req.user._id,
      actionType: 'lead_notification_preference_updated',
      description: `${enabled ? 'Enabled' : 'Disabled'} automatic ${channel} notifications for ${getLeadName(lead)}`,
      entityType: type,
      entityId: lead._id,
      metadata: { channel, previousValue, enabled },
    });

    return successResponse(res, 200, `${channel === 'email' ? 'Email' : 'WhatsApp'} notifications ${enabled ? 'enabled' : 'disabled'}`, {
      notificationPreferences: lead.notificationPreferences,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update lead status (unified)
// @route   PUT /api/leads/unified/:type/:id/status
// @access  Private
export const updateLeadStatus = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { status, scheduledDateTime, statusDate, details, comment } = req.body;
    const newStatus = normalizeStatus(status);
    const Model = getLeadModel(type);
    if (!Model || !LEAD_STATUSES.has(newStatus)) {
      return errorResponse(res, 400, 'Invalid lead type or status');
    }

    let statusChangedAt;
    try {
      statusChangedAt = parseLeadStatusDate(statusDate);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }
    
    const existingLead = await findUnifiedLeadForUser(type, id, req.user);
    if (!existingLead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const statusField = getLeadStatusField(type);
    const oldStatus = existingLead[statusField];
    const cleanedComment = typeof comment === 'string' ? comment.trim() : '';
    if ((oldStatus !== newStatus || details !== undefined) && !cleanedComment) {
      return errorResponse(res, 400, 'Please write comment');
    }
    if (cleanedComment.length > 4000) {
      return errorResponse(res, 400, 'Comment is too long');
    }
    const update = { [statusField]: newStatus };
    let parsedStatusDetails;
    if (oldStatus !== newStatus) update.leadStatusChangedAt = statusChangedAt;
    if (scheduledDateTime) update.scheduledDateTime = scheduledDateTime;
    if (newStatus === 'Demo Scheduled' && scheduledDateTime) update.followTypeDate = scheduledDateTime;
    if ((Model === Company && details !== undefined) || newStatus === 'Demo follow-up') {
      try {
        const parsedDetails = parseStatusDetails(newStatus, details);
        parsedStatusDetails = parsedDetails;
        update.statusDetails = {
          ...parsedDetails,
          savedBy: req.user._id,
          savedAt: new Date(),
        };
        if (newStatus === 'Demo Scheduled') {
          update.scheduledDateTime = parsedDetails.demoDateTime;
          update.followTypeDate = parsedDetails.demoDateTime;
        }
      } catch (error) {
        return errorResponse(res, 400, error.message);
      }
    }
    if (Model === Company && newStatus !== 'Follow Up') {
      update.followUpRequired = false;
      update.followUpDateTime = null;
      update.followUpType = null;
      update.followUpPriority = null;
      update.followUpReminder = null;
    }

    const lead = await Model.findByIdAndUpdate(id, update, { new: true });

    if (Model === Company && newStatus !== 'Follow Up') {
      const activeFollowUps = await FollowUp.find({
        lead: lead._id,
        ...(newStatus === 'Demo follow-up' ? { activeKey: { $ne: `demo-follow-up:${lead._id}` } } : {}),
        status: { $in: ['Pending', 'Snoozed'] },
      }).select('_id').lean();
      if (activeFollowUps.length) {
        await FollowUp.bulkWrite(activeFollowUps.map((followUp) => ({
          updateOne: {
            filter: { _id: followUp._id },
            update: {
              $set: { status: 'Cancelled' },
              $unset: { activeKey: 1 },
            },
          },
        })), { ordered: false });
        await Promise.all(activeFollowUps.map((followUp) => (
          cancelFollowUpReminder(followUp._id)
        )));
      }
    }

    if (Model === Company && (newStatus === 'Demo follow-up' || oldStatus === 'Demo follow-up')) {
      await syncDemoFollowUpReminder(lead, req.user._id);
    }

    const lastCall = await CallLog.findOne({
      lead: lead._id,
      leadModel: type,
      calledBy: req.user._id,
      callDatetime: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
    }).sort({ callDatetime: -1 });

    const callId = lastCall ? lastCall._id : null;

    if (oldStatus !== newStatus) {
      await LeadStatusHistory.create({
        lead: lead._id,
        leadModel: type,
        oldStatus,
        newStatus,
        changedBy: req.user._id,
        changedAt: statusChangedAt,
        entryType: 'status_change',
        details: parsedStatusDetails || null,
        comment: cleanedComment,
        call: callId,
      });

      await logActivity({
        user: req.user._id,
        actionType: 'lead_status_changed',
        description: `Changed ${getLeadName(lead)} from ${oldStatus || 'blank'} to ${newStatus}`,
        entityType: type,
        entityId: lead._id,
        metadata: { oldStatus, newStatus, statusDate: statusChangedAt.toISOString() },
      });

      if (!(Model === Company && newStatus === 'Follow Up')) {
        await sendAutomatedLeadStatusNotifications({
          leadType: type,
          lead,
          status: newStatus,
          actorUserId: req.user._id,
          trigger: 'status_changed',
        });
      }
    } else if (parsedStatusDetails || cleanedComment) {
      await LeadStatusHistory.create({
        lead: lead._id,
        leadModel: type,
        oldStatus,
        newStatus,
        changedBy: req.user._id,
        changedAt: update.statusDetails?.savedAt || new Date(),
        entryType: 'details_saved',
        details: parsedStatusDetails || { status: newStatus, note: cleanedComment },
        comment: cleanedComment || null,
        call: callId,
      });
    }

    await invalidateLeadMetricsCaches();
    return successResponse(res, 200, 'Status updated', lead);
  } catch (error) {
    next(error);
  }
};

// @desc    Save or clear a company lead follow-up
// @route   PUT /api/leads/unified/:type/:id/follow-up
// @access  Private
export const updateLeadFollowUp = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    if (type !== 'Company') {
      return errorResponse(res, 400, 'Follow-ups are only available for company leads');
    }

    let update;
    try {
      update = parseFollowUpPayload(req.body);
    } catch (error) {
      return errorResponse(res, 400, error.message);
    }

    const existingLead = await findUnifiedLeadForUser(type, id, req.user);
    if (!existingLead) {
      return errorResponse(res, 404, 'Lead not found');
    }

    const lead = await Company.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true },
    )
      .populate('createdBy', 'name role email')
      .populate('assignedTo', 'name role email')
      .populate('comments.createdBy', 'name');

    await logActivity({
      user: req.user._id,
      actionType: update.followUpRequired ? 'lead_follow_up_saved' : 'lead_follow_up_cleared',
      description: `${update.followUpRequired ? 'Saved' : 'Cleared'} follow-up for ${getLeadName(lead)}`,
      entityType: 'Company',
      entityId: lead._id,
      metadata: update,
    });

    if (update.followUpRequired) {
      await sendAutomatedLeadStatusNotifications({
        leadType: 'Company',
        lead,
        status: 'Follow Up',
        actorUserId: req.user._id,
        trigger: 'follow_up_saved',
      });
    }

    await invalidateLeadMetricsCaches();

    return successResponse(
      res,
      200,
      update.followUpRequired ? 'Follow-up saved successfully' : 'Follow-up cleared successfully',
      lead,
    );
  } catch (error) {
    next(error);
  }
};


// @desc    Add comment to lead (unified)
// @route   POST /api/leads/unified/:type/:id/comment
// @access  Private
export const addLeadComment = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { text } = req.body;
    const cleanedText = typeof text === 'string' ? text.trim() : '';
    if (!cleanedText) return errorResponse(res, 400, 'Comment text is required');
    if (cleanedText.length > 4000) return errorResponse(res, 400, 'Comment text is too long');
    
    let attachment;
    if (req.file) {
      const fileUrl = `/uploads/${req.file.filename}`;
      attachment = {
        url: fileUrl,
        fileType: req.file.mimetype.startsWith('video/') ? 'video' : 'image'
      };
    }
    
    const Model = getLeadModel(type);
    const existingLead = await findUnifiedLeadForUser(type, id, req.user);
    if (!Model || !existingLead) return res.status(404).json({ success: false, message: 'Lead not found' });

    const statusField = getLeadStatusField(type);
    const comment = {
      text: cleanedText,
      status: existingLead[statusField],
      createdBy: req.user._id,
      createdAt: new Date(),
    };
    if (attachment) {
      comment.attachment = attachment;
    }

    const lead = await Model.findByIdAndUpdate(id, { $push: { comments: comment } }, { new: true }).populate('comments.createdBy', 'name');

    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });

    return successResponse(res, 200, 'Comment added', lead);
  } catch (error) {
    next(error);
  }
};

// @desc    Assign lead to a user
// @route   PUT /api/leads/unified/:type/:id/assign
// @access  Private
export const assignLead = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const { assignedTo } = req.body;
    if (!(await assertCanAssignToUser(req.user, assignedTo))) {
      return errorResponse(res, 403, 'You are not allowed to assign leads to this user');
    }

    const Model = getLeadModel(type);
    const existingLead = await findUnifiedLeadForUser(type, id, req.user);
    if (!Model || !existingLead) return res.status(404).json({ success: false, message: 'Lead not found' });

    await ensureAssigneeArray(Model, existingLead);
    const lead = await Model.findByIdAndUpdate(id, { $addToSet: { assignedTo } }, { new: true }).populate('assignedTo', 'name');

    if (!lead) return res.status(404).json({ success: false, message: 'Lead not found' });
    if (Model === Company) {
      await FollowUp.updateMany(
        { lead: lead._id, status: { $in: ['Pending', 'Snoozed'] } },
        { $set: { assignedTo: lead.assignedTo.map((user) => user._id || user) } },
      );
    }

    await Notification.create({
      title: 'New Lead Assigned',
      message: `You have been assigned a new ${type} lead: ${lead.companyName || lead.name || lead.customerName}.`,
      type: 'info',
      user: assignedTo
    });

    await invalidateLeadMetricsCaches();
    return successResponse(res, 200, 'Lead assigned successfully', lead);
  } catch (error) {
    next(error);
  }
};

// @desc    Bulk assign unified leads
// @route   PUT /api/leads/bulk-assign
// @access  Private
export const bulkAssignLeads = async (req, res, next) => {
  try {
    const { assignedTo, leads = [] } = req.body;
    if (!Array.isArray(leads) || leads.length === 0) {
      return errorResponse(res, 400, 'Select at least one lead');
    }

    if (!(await assertCanAssignToUser(req.user, assignedTo))) {
      return errorResponse(res, 403, 'You are not allowed to assign leads to this user');
    }

    const { query: visibility } = await resolveLeadVisibility(req.user);
    const modelGroups = [
      { type: 'Customer', Model: Customer },
      { type: 'Company', Model: Company },
      { type: 'Lead', Model: Lead },
    ];
    const requestedByType = new Map(modelGroups.map(({ type }) => [
      type,
      Array.from(new Set(
        leads.filter((item) => item?.type === type && item.id).map((item) => String(item.id)),
      )),
    ]));

    const visibleGroups = await Promise.all(modelGroups.map(async ({ type, Model }) => {
      const ids = requestedByType.get(type);
      if (!ids.length) return { type, Model, rows: [] };
      const rows = await Model.find({ _id: { $in: ids }, ...visibility })
        .select('name companyName customerName assignedTo')
        .lean();
      return { type, Model, rows };
    }));

    const updateJobs = [];
    const notificationOperations = [];
    const activityOperations = [];
    const followUpOperations = [];
    let updatedCount = 0;

    visibleGroups.forEach(({ type, Model, rows }) => {
      if (!rows.length) return;
      updatedCount += rows.length;
      updateJobs.push(Model.bulkWrite(rows.map((lead) => ({
        updateOne: {
          filter: { _id: lead._id },
          update: Array.isArray(lead.assignedTo)
            ? { $addToSet: { assignedTo } }
            : {
                $set: {
                  assignedTo: Array.from(new Set([
                    ...normalizeAssignees(lead.assignedTo).map(String),
                    String(assignedTo),
                  ])),
                },
              },
        },
      })), { ordered: false }));

      rows.forEach((lead) => {
        const leadName = getLeadName(lead);
        notificationOperations.push({
          insertOne: {
            document: {
              title: 'New Lead Assigned',
              message: `You have been assigned a new ${type} lead: ${leadName}.`,
              type: 'info',
              user: assignedTo,
            },
          },
        });
        activityOperations.push({
          insertOne: {
            document: {
              user: req.user._id,
              actionType: 'lead_assigned',
              description: `Assigned ${leadName} to a user`,
              entityType: type,
              entityId: lead._id,
              metadata: { assignedTo },
            },
          },
        });
        if (type === 'Company') {
          followUpOperations.push({
            updateMany: {
              filter: { lead: lead._id, status: { $in: ['Pending', 'Snoozed'] } },
              update: {
                $set: {
                  assignedTo: Array.from(new Set([
                    ...normalizeAssignees(lead.assignedTo).map(String),
                    String(assignedTo),
                  ])),
                },
              },
            },
          });
        }
      });
    });

    if (notificationOperations.length) {
      updateJobs.push(Notification.bulkWrite(notificationOperations, { ordered: false }));
    }
    if (followUpOperations.length) {
      updateJobs.push(FollowUp.bulkWrite(followUpOperations, { ordered: false }));
    }
    if (activityOperations.length) {
      updateJobs.push(
        ActivityLog.bulkWrite(activityOperations, { ordered: false })
          .catch((error) => console.error('Bulk activity log failed:', error.message)),
      );
    }
    await Promise.all(updateJobs);

    if (updatedCount > 0) await invalidateLeadMetricsCaches();
    return successResponse(res, 200, `${updatedCount} leads assigned successfully`, {
      updatedCount,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Start a click-to-call bridge for a unified lead
// @route   POST /api/leads/unified/:type/:id/call
// @access  Private
export const startLeadCall = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const lead = await findUnifiedLeadForUser(type, id, req.user);
    if (!lead) return errorResponse(res, 404, 'Lead not found');

    const leadPhone = normalizePhone(lead.mobileNo || lead.phoneNo || lead.phone);
    const browserMode = req.body.mode === 'browser';
    const agentPhone = normalizePhone(req.user.phone);
    if (!leadPhone) return errorResponse(res, 400, 'Lead phone must include country code (for example +919876543210)');
    if (!browserMode && !agentPhone) return errorResponse(res, 400, 'Add your phone with country code in your CRM user profile before calling');
    let callerId;
    try {
      callerId = await selectNextCallingNumber();
    } catch (error) {
      return errorResponse(res, error.statusCode || 409, error.message);
    }

    const callLog = await CallLog.create({
      lead: lead._id,
      leadModel: type,
      calledBy: req.user._id,
      direction: 'outbound',
      status: 'queued',
      fromNumber: callerId,
      toNumber: leadPhone,
      virtualNumber: callerId,
      customerNumber: leadPhone,
    });
    let providerResponse;
    try {
      if (browserMode) {
        providerResponse = await prepareBrowserCall({ callLog, user: req.user });
      } else {
        providerResponse = await createPlivoBridge({ callLog, agentNumber: agentPhone });
        callLog.providerCallId = providerResponse.request_uuid || providerResponse.requestUuid;
        callLog.status = 'ringing';
        await callLog.save();
      }
      await saveCallbackRoute({ callLog });
    } catch (error) {
      callLog.status = 'failed';
      await callLog.save();
      console.error('Call preparation failed:', error);
      return errorResponse(res, 502, 'Call could not be started. Please try again.');
    }

    await logActivity({
      user: req.user._id,
      actionType: 'click_to_call',
      description: `Started call for ${getLeadName(lead)}`,
      entityType: type,
      entityId: lead._id,
      metadata: { callLog: callLog._id, providerCallId: callLog.providerCallId },
    });

    return successResponse(res, 201, browserMode ? 'Browser call prepared' : 'Call bridge requested', { callLog, providerResponse, mode: browserMode ? 'browser' : 'bridge' });
  } catch (error) {
    next(error);
  }
};

// @desc    Get call history for a unified lead
// @route   GET /api/leads/unified/:type/:id/calls
// @access  Private
export const getLeadCallLogs = async (req, res, next) => {
  try {
    const { type, id } = req.params;
    const lead = await findUnifiedLeadForUser(type, id, req.user);
    if (!lead) return errorResponse(res, 404, 'Lead not found');

    const calls = await CallLog.find({ lead: id, leadModel: type })
      .populate('calledBy', 'name role')
      .populate('manualCommentBy', 'name')
      .sort({ callDatetime: -1 });

    return successResponse(res, 200, 'Call logs fetched', calls);
  } catch (error) {
    next(error);
  }
};

// @desc    Update manual call comment
// @route   PUT /api/leads/calls/:callLogId/comment
// @access  Private
export const updateCallManualComment = async (req, res, next) => {
  try {
    const { manualComment } = req.body;
    const callLog = await CallLog.findById(req.params.callLogId);
    if (!callLog) return errorResponse(res, 404, 'Call log not found');

    const lead = await findUnifiedLeadForUser(callLog.leadModel, callLog.lead, req.user);
    if (!lead) return errorResponse(res, 404, 'Call log not found');

    callLog.manualComment = manualComment || '';
    callLog.manualCommentBy = req.user._id;
    await callLog.save();

    return successResponse(res, 200, 'Manual comment updated', callLog);
  } catch (error) {
    next(error);
  }
};

// @desc    Telephony webhook for completed calls
// @route   POST /api/leads/webhooks/call-completed
// @access  Provider webhook
export const callCompletedWebhook = async (req, res, next) => {
  try {
    const {
      callLogId,
      providerCallId,
      durationSeconds = 0,
      recordingUrl,
      transcriptText = '',
      status = 'completed',
    } = req.body;

    const query = callLogId ? { _id: callLogId } : { providerCallId };
    const callLog = await CallLog.findOne(query);
    if (!callLog) return errorResponse(res, 404, 'Call log not found');

    const analysis = analyzeTranscript(transcriptText);
    Object.assign(callLog, {
      durationSeconds,
      recordingUrl,
      transcriptText,
      status,
      ...analysis,
    });
    await callLog.save();

    await logActivity({
      user: callLog.calledBy,
      actionType: 'call_completed',
      description: 'Call completed and analysis saved',
      entityType: callLog.leadModel,
      entityId: callLog.lead,
      metadata: { callLog: callLog._id, providerCallId: callLog.providerCallId },
    });

    return successResponse(res, 200, 'Call completion processed', callLog);
  } catch (error) {
    next(error);
  }
};
