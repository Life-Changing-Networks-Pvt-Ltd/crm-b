import { FOLLOW_UP_REMINDERS } from './followUp.js';
import { parseLeadStatusDate } from './leadStatusDate.js';

const TEXT_LIMITS = {
  note: 4000,
  productService: 500,
  demoMode: 30,
  meetingLink: 1000,
  location: 500,
  reminder: 30,
  reason: 500,
  requirement: 2000,
  committedProductService: 500,
};

const DATE_FIELDS = [
  'expectedDecisionDate',
  'demoDateTime',
  'demoFollowUpDateTime',
  'expectedClosingDate',
  'expectedCompletionDate',
  'convertedAt',
];

const NUMBER_FIELDS = ['estimatedDealValue', 'dealValue', 'finalDealValue'];
const STATUS_FIELDS = {
  New: ['note'],
  'Demo follow-up': ['demoFollowUpDateTime', 'reminder', 'note'],
  'Demo Scheduled': ['demoDateTime', 'demoMode', 'meetingLink', 'location', 'reminder', 'note'],
  Interested: ['productService', 'expectedDecisionDate', 'note'],
  'Not Interested': ['reason', 'note'],
  Committed: ['committedProductService', 'dealValue', 'expectedCompletionDate', 'note'],
  Converted: ['productService', 'finalDealValue', 'convertedAt', 'note'],
};

const cleanText = (value, field) => {
  if (value === undefined || value === null || value === '') return null;
  const cleaned = String(value).trim();
  if (cleaned.length > TEXT_LIMITS[field]) {
    throw new RangeError(`${field} is too long`);
  }
  return cleaned || null;
};

export const parseStatusDetails = (status, payload = {}, now = new Date()) => {
  const details = { status };
  for (const field of Object.keys(TEXT_LIMITS)) {
    details[field] = cleanText(payload[field], field);
  }
  for (const field of DATE_FIELDS) {
    if (field === 'demoFollowUpDateTime' && status !== 'Demo follow-up') {
      details[field] = null;
      continue;
    }
    if (!payload[field]) {
      details[field] = field === 'convertedAt' && status === 'Converted' ? new Date(now) : null;
      continue;
    }
    if (field === 'demoFollowUpDateTime' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(payload[field])) {
      throw new RangeError('Demo follow-up date and time must include a timezone');
    }
    const value = field === 'demoFollowUpDateTime' ? parseLeadStatusDate(payload[field]) : new Date(payload[field]);
    if (Number.isNaN(value.getTime())) throw new RangeError(`${field} is invalid`);
    details[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === '') {
      details[field] = null;
      continue;
    }
    const value = Number(payload[field]);
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${field} must be a positive number`);
    details[field] = value;
  }

  if (status === 'Demo follow-up') {
    details.reminder = details.reminder || '30_minutes';
    if (!FOLLOW_UP_REMINDERS.includes(details.reminder)) throw new RangeError('Demo follow-up Reminder is invalid');
  }
  if (status === 'Demo follow-up' && !details.demoFollowUpDateTime) {
    throw new RangeError('Demo follow-up Date & Time is required');
  }
  if (status === 'Demo Scheduled') {
    if (!details.demoDateTime) throw new RangeError('Demo Date & Time is required');
    if (!['Online', 'On-site'].includes(details.demoMode)) {
      throw new RangeError('Demo Mode must be Online or On-site');
    }
  }
  if (status === 'Not Interested' && !details.reason) {
    throw new RangeError('Not Interested reason is required');
  }

  const allowed = new Set(STATUS_FIELDS[status] || ['note']);
  for (const field of [...Object.keys(TEXT_LIMITS), ...DATE_FIELDS, ...NUMBER_FIELDS]) {
    if (!allowed.has(field)) details[field] = null;
  }

  return details;
};
