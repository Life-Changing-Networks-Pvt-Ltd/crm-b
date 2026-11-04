import mongoose from 'mongoose';
import Company from '../models/Company.js';
import FollowUp from '../models/FollowUp.js';
import { resolveLeadVisibility } from '../services/leadAccessService.js';
import { getFirstReminderAt, parseFollowUpPayload } from '../utils/followUp.js';
import {
  cancelFollowUpReminder,
  filterExistingLeadReminders,
  followUpReminderPayload,
  scheduleFollowUpReminder,
} from '../services/followUpReminderService.js';
import { sendAutomatedLeadStatusNotifications } from '../services/leadStatusNotificationService.js';
import { invalidateLeadMetricsCaches } from '../services/cacheService.js';

const ACTIVE_STATUSES = ['Pending', 'Snoozed'];

const visibleCompany = async (leadId, user, access) => {
  if (!mongoose.isValidObjectId(leadId)) return null;
  const { query } = await resolveLeadVisibility(user, access);
  return Company.findOne({ _id: leadId, ...query });
};

const attachmentFromRequest = (req) => req.file ? {
  url: `/uploads/${req.file.filename}`,
  fileType: req.file.mimetype.startsWith('video/') ? 'video' : 'image',
} : undefined;

const activeKeyFor = (leadId) => `company:${leadId}`;
const REMINDER_STATUSES = new Set(['Follow Up', 'Demo follow-up', 'Demo Scheduled']);

const accessibleActiveFollowUp = async (id, user, access) => {
  if (!mongoose.isValidObjectId(id)) return null;
  const { query } = await resolveLeadVisibility(user, access);
  const leadIds = await Company.find(query).distinct('_id');
  return FollowUp.findOne({
    _id: id,
    status: { $in: ACTIVE_STATUSES },
    lead: { $in: leadIds },
  });
};

const clearCompanyFollowUp = (company) => {
  company.followUpRequired = false;
  company.followUpDateTime = null;
  company.followUpType = null;
  company.followUpPriority = null;
  company.followUpReminder = null;
};

export const saveLeadFollowUp = async (req, res) => {
  try {
    const company = await visibleCompany(req.params.leadId, req.user, req.access);
    if (!company) return res.status(404).json({ message: 'Company lead not found' });

    const required = req.body.followUpRequired === true || req.body.followUpRequired === 'true';
    const sourceStatus = String(req.body.sourceStatus || company.leadStatus);
    if (required && (!REMINDER_STATUSES.has(sourceStatus) || sourceStatus !== company.leadStatus)) {
      return res.status(400).json({ message: 'Select a reminder-enabled Lead Status first' });
    }
    const activeKey = activeKeyFor(company._id);
    const activeFollowUps = await FollowUp.find({
      lead: company._id,
      status: { $in: ACTIVE_STATUSES },
    });
    const existing = activeFollowUps.find((item) => item.activeKey === activeKey)
      || activeFollowUps[0]
      || null;
    const superseded = activeFollowUps.filter((item) => !existing || !item._id.equals(existing._id));
    for (const item of superseded) {
      item.status = 'Cancelled';
      item.activeKey = undefined;
      await item.save();
      await cancelFollowUpReminder(item._id);
    }

    if (!required) {
      if (existing) {
        existing.status = 'Cancelled';
        existing.activeKey = undefined;
        await existing.save();
        await cancelFollowUpReminder(existing._id);
      }
      clearCompanyFollowUp(company);
      await company.save();
      await invalidateLeadMetricsCaches();
      return res.json({ message: 'Follow-up cleared successfully', data: { followUp: null } });
    }

    const parsed = parseFollowUpPayload({
      followUpRequired: true,
      followUpDateTime: req.body.followUpDateTime,
      followUpType: req.body.followUpType,
      followUpPriority: req.body.followUpPriority,
      followUpReminder: req.body.followUpReminder,
    });
    const message = String(req.body.message || '').trim();
    if (!message) return res.status(400).json({ message: 'Please write comment' });
    if (message.length > 4000) return res.status(400).json({ message: 'Follow-up message cannot exceed 4000 characters' });

    const assignees = Array.isArray(company.assignedTo) && company.assignedTo.length
      ? company.assignedTo
      : [req.user._id];
    const nextReminderAt = getFirstReminderAt(parsed.followUpDateTime, parsed.followUpReminder);
    const attachment = attachmentFromRequest(req);
    const values = {
      lead: company._id,
      activeKey,
      companyName: company.companyName,
      message,
      sourceStatus,
      followUpDateTime: parsed.followUpDateTime,
      type: parsed.followUpType,
      priority: parsed.followUpPriority,
      reminderBefore: parsed.followUpReminder,
      status: 'Pending',
      assignedTo: assignees,
      nextReminderAt,
      lastRemindedAt: null,
      reminderCount: 0,
      snoozedUntil: null,
      ...(attachment ? { attachment } : {}),
    };

    let followUp;
    if (existing) {
      existing.status = 'Completed';
      existing.activeKey = undefined;
      existing.completedAt = new Date();
      existing.completedBy = req.user._id;
      await existing.save();
      await cancelFollowUpReminder(existing._id);
    }
    followUp = await FollowUp.create({ ...values, createdBy: req.user._id });

    company.followUpRequired = true;
    company.followUpDateTime = parsed.followUpDateTime;
    company.followUpType = parsed.followUpType;
    company.followUpPriority = parsed.followUpPriority;
    company.followUpReminder = parsed.followUpReminder;
    if (sourceStatus === 'Demo follow-up') {
      company.statusDetails = {
        ...(company.statusDetails?.toObject?.() || company.statusDetails || {}),
        status: sourceStatus,
        demoFollowUpDateTime: parsed.followUpDateTime,
        reminder: parsed.followUpReminder,
      };
    }
    if (sourceStatus === 'Demo Scheduled') {
      company.statusDetails = {
        ...(company.statusDetails?.toObject?.() || company.statusDetails || {}),
        status: sourceStatus,
        demoDateTime: parsed.followUpDateTime,
        reminder: parsed.followUpReminder,
      };
      company.scheduledDateTime = parsed.followUpDateTime;
      company.followTypeDate = parsed.followUpDateTime;
    }
    await company.save();
    await scheduleFollowUpReminder(followUp._id, followUp.nextReminderAt);
    await sendAutomatedLeadStatusNotifications({
      leadType: 'Company',
      lead: company,
      status: sourceStatus,
      actorUserId: req.user._id,
      trigger: 'follow_up_saved',
    });
    await invalidateLeadMetricsCaches();

    return res.json({
      message: 'Follow-up saved successfully',
      data: {
        followUp: followUp.toObject(),
        schedule: {
          status: sourceStatus,
          followUpDateTime: parsed.followUpDateTime,
          reminder: parsed.followUpReminder,
        },
      },
    });
  } catch (error) {
    if (error instanceof RangeError) return res.status(400).json({ message: error.message });
    if (error?.code === 11000) return res.status(409).json({ message: 'This lead already has an active follow-up' });
    console.error('Save follow-up error:', error);
    return res.status(500).json({ message: 'Failed to save follow-up' });
  }
};

export const getLeadFollowUps = async (req, res) => {
  try {
    const company = await visibleCompany(req.params.leadId, req.user, req.access);
    if (!company) return res.status(404).json({ message: 'Company lead not found' });
    const items = await FollowUp.find({ lead: company._id })
      .populate('createdBy completedBy', 'name')
      .sort({ createdAt: -1 })
      .lean();
    const active = items.find((item) => ACTIVE_STATUSES.includes(item.status)) || null;
    return res.json({ data: { active, items } });
  } catch (error) {
    console.error('Get follow-ups error:', error);
    return res.status(500).json({ message: 'Failed to load follow-ups' });
  }
};

export const getPendingFollowUps = async (req, res) => {
  try {
    const items = await FollowUp.find({
      assignedTo: req.user._id,
      $or: [
        { status: 'Pending', lastRemindedAt: { $ne: null } },
        { status: 'Snoozed', nextReminderAt: { $lte: new Date() } },
      ],
    }).sort({ lastRemindedAt: -1 }).limit(20).lean();
    const valid = await filterExistingLeadReminders(items);
    return res.json({ data: valid.map(followUpReminderPayload) });
  } catch (error) {
    console.error('Get pending follow-ups error:', error);
    return res.status(500).json({ message: 'Failed to load pending reminders' });
  }
};

export const completeFollowUp = async (req, res) => {
  try {
    const followUp = await accessibleActiveFollowUp(req.params.id, req.user, req.access);
    if (!followUp) return res.status(404).json({ message: 'Active follow-up not found' });
    followUp.status = 'Completed';
    followUp.activeKey = undefined;
    followUp.completedAt = new Date();
    followUp.completedBy = req.user._id;
    await followUp.save();
    await cancelFollowUpReminder(followUp._id);
    const company = await Company.findById(followUp.lead);
    if (company) {
      clearCompanyFollowUp(company);
      await company.save();
    }
    await invalidateLeadMetricsCaches();
    return res.json({ message: 'Follow-up completed successfully', data: followUp });
  } catch (error) {
    console.error('Complete follow-up error:', error);
    return res.status(500).json({ message: 'Failed to complete follow-up' });
  }
};

export const snoozeFollowUp = async (req, res) => {
  try {
    const minutes = Number(req.body.minutes || 5);
    if (![5, 15, 30, 60].includes(minutes)) {
      return res.status(400).json({ message: 'Snooze duration is invalid' });
    }
    const followUp = await accessibleActiveFollowUp(req.params.id, req.user, req.access);
    if (!followUp) return res.status(404).json({ message: 'Active follow-up not found' });
    const snoozedUntil = new Date(Date.now() + minutes * 60 * 1000);
    followUp.status = 'Snoozed';
    followUp.snoozedUntil = snoozedUntil;
    followUp.nextReminderAt = snoozedUntil;
    await followUp.save();
    await scheduleFollowUpReminder(followUp._id, snoozedUntil);
    return res.json({ message: `Reminder snoozed for ${minutes} minutes`, data: followUp });
  } catch (error) {
    console.error('Snooze follow-up error:', error);
    return res.status(500).json({ message: 'Failed to snooze reminder' });
  }
};
