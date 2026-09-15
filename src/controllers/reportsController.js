import Event from '../models/Event.js';
import Company from '../models/Company.js';
import Customer from '../models/Customer.js';
import ActivityLog from '../models/ActivityLog.js';
import {
  buildSalesReportPipeline,
  getMeetingReportData,
  getSalesPerformanceData,
  getSalesReportData,
  getUserReportData,
} from '../services/reportQueryService.js';
import { streamCsv } from '../utils/csvStream.js';
import mongoose from 'mongoose';
import { resolveUserDataScope } from '../services/dataScopeService.js';

const scopedReportQuery = async (req) => {
  const visibility = await resolveUserDataScope(req.user, 'reports', req.access);
  if (visibility.scope === 'all') return { ...req.query, _visibleUserIds: undefined };
  return {
    ...req.query,
    _visibleUserIds: visibility.userIds
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id)),
  };
};

const leadOwnershipFilter = (visibleUserIds) => (
  Array.isArray(visibleUserIds)
    ? {
        $or: [
          { createdBy: { $in: visibleUserIds } },
          { assignedTo: { $in: visibleUserIds } },
        ],
      }
    : {}
);

const creatorFilter = (visibleUserIds) => (
  Array.isArray(visibleUserIds) ? { createdBy: { $in: visibleUserIds } } : {}
);

const INDIA_OFFSET = '+05:30';
const PIPELINE_STATUSES = ['New', 'Follow Up', 'Interested', 'Demo Scheduled', 'Demo follow-up', 'Committed', 'Converted', 'Not Interested'];
const DAY_MS = 24 * 60 * 60 * 1000;

const indiaDateString = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value: partValue }) => [type, partValue]));
  return `${value.year}-${value.month}-${value.day}`;
};

const indiaDayStart = (dateString) => new Date(`${dateString}T00:00:00.000${INDIA_OFFSET}`);

const dashboardDateRange = ({ period, startDate, endDate }) => {
  if (!period || period === 'All') return null;
  const today = indiaDateString();
  if (period === 'Today') {
    const start = indiaDayStart(today);
    return { $gte: start, $lte: new Date(start.getTime() + DAY_MS - 1) };
  }
  if (period === 'This Week') {
    const utcToday = new Date(`${today}T00:00:00.000Z`);
    const start = new Date(indiaDayStart(today).getTime() - utcToday.getUTCDay() * DAY_MS);
    return { $gte: start, $lte: new Date(start.getTime() + 7 * DAY_MS - 1) };
  }
  if (period === 'This Month') {
    const [year, month] = today.split('-').map(Number);
    const start = indiaDayStart(`${year}-${String(month).padStart(2, '0')}-01`);
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    const end = indiaDayStart(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`);
    return { $gte: start, $lte: new Date(end.getTime() - 1) };
  }
  if (period === 'Date Range') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
      throw Object.assign(new Error('A valid start date and end date are required'), { statusCode: 400 });
    }
    const start = indiaDayStart(startDate);
    const end = new Date(indiaDayStart(endDate).getTime() + DAY_MS - 1);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      throw Object.assign(new Error('A valid start date and end date are required'), { statusCode: 400 });
    }
    return { $gte: start, $lte: end };
  }
  return null;
};

const dateExpressionFilter = (expression, range) => (
  range
    ? { $expr: { $and: [{ $gte: [expression, range.$gte] }, { $lte: [expression, range.$lte] }] } }
    : {}
);

const mergeTrendRows = (createdRows, convertedRows) => {
  const points = new Map();
  createdRows.forEach(({ _id, count }) => points.set(_id, { period: _id, newLeads: count, converted: 0 }));
  convertedRows.forEach(({ _id, count }) => {
    const point = points.get(_id) || { period: _id, newLeads: 0, converted: 0 };
    point.converted = count;
    points.set(_id, point);
  });
  return [...points.values()].sort((a, b) => a.period.localeCompare(b.period));
};

export const getDashboardReport = async (req, res) => {
  try {
    const scopedQuery = await scopedReportQuery(req);
    const visibleUserIds = scopedQuery._visibleUserIds;
    const leadFilter = leadOwnershipFilter(visibleUserIds);
    const activityFilter = creatorFilter(visibleUserIds);
    const period = req.query.period || 'All';
    const range = dashboardDateRange({
      period,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    const companyPeriodFilter = { ...leadFilter, ...(range ? { createdAt: range } : {}) };
    const meetingPeriodFilter = { type: 'Meeting', ...activityFilter, ...(range ? { date: range } : {}) };
    const activityPeriodFilter = {
      ...(Array.isArray(visibleUserIds) ? { user: { $in: visibleUserIds } } : {}),
      entityType: { $in: ['Company', 'Event'] },
      ...(range ? { createdAt: range } : {}),
    };
    const convertedDate = {
      $ifNull: ['$statusDetails.convertedAt', { $ifNull: ['$leadStatusChangedAt', '$createdAt'] }],
    };
    const convertedFilter = {
      ...leadFilter,
      leadStatus: 'Converted',
      ...dateExpressionFilter(convertedDate, range),
    };
    const now = new Date();
    const followUpDateRange = range
      ? { $gte: range.$gte, $lte: new Date(Math.min(range.$lte.getTime(), now.getTime())) }
      : { $lte: now };
    const followUpFilter = {
      ...leadFilter,
      followUpRequired: true,
      followUpDateTime: followUpDateRange,
    };
    const dateFormat = period === 'All' ? '%Y-%m' : '%Y-%m-%d';
    const dateGroup = (date) => ({ $dateToString: { format: dateFormat, date, timezone: 'Asia/Kolkata' } });
    const [
      totalCustomers,
      totalCompanies,
      newLeads,
      convertedCustomers,
      pipelineValueRows,
      wonRevenueRows,
      followUpsDue,
      meetingsCompleted,
      pipelineRows,
      sourceRows,
      createdTrendRows,
      convertedTrendRows,
      recentActivityLogs,
      recentMeetings,
    ] = await Promise.all([
      Customer.countDocuments(leadFilter),
      Company.countDocuments(leadFilter),
      Company.countDocuments(companyPeriodFilter),
      Company.countDocuments(convertedFilter),
      Company.aggregate([
        { $match: { ...companyPeriodFilter, leadStatus: { $in: ['Interested', 'Committed'] } } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$statusDetails.dealValue', { $ifNull: ['$statusDetails.estimatedDealValue', 0] }] } } } },
      ]),
      Company.aggregate([
        { $match: convertedFilter },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$statusDetails.finalDealValue', 0] } } } },
      ]),
      Company.countDocuments(followUpFilter),
      Event.countDocuments({ ...meetingPeriodFilter, status: 'Completed' }),
      Company.aggregate([
        { $match: companyPeriodFilter },
        { $group: { _id: { $ifNull: ['$leadStatus', 'New'] }, count: { $sum: 1 } } },
      ]),
      Company.aggregate([
        { $match: companyPeriodFilter },
        { $group: { _id: { $ifNull: ['$leadSource', 'Direct'] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Company.aggregate([
        { $match: companyPeriodFilter },
        { $group: { _id: dateGroup('$createdAt'), count: { $sum: 1 } } },
      ]),
      Company.aggregate([
        { $match: convertedFilter },
        { $group: { _id: dateGroup(convertedDate), count: { $sum: 1 } } },
      ]),
      ActivityLog.find(activityPeriodFilter)
        .select('description actionType entityType entityId createdAt user')
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('user', 'name')
        .lean(),
      Event.find({ type: 'Meeting', ...activityFilter, ...(range ? { createdAt: range } : {}) })
        .select('title createdAt createdBy _id')
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('createdBy', 'name')
        .lean(),
    ]);

    const recentActivities = [
      ...recentActivityLogs.map((item) => ({
        id: item._id,
        action: item.description,
        date: item.createdAt,
        user: item.user?.name || 'System',
        actionType: item.actionType,
        entityType: item.entityType,
        entityId: item.entityId,
      })),
      ...recentMeetings.map((item) => ({
        id: item._id,
        action: `Meeting scheduled: ${item.title}`,
        date: item.createdAt,
        user: item.createdBy?.name || 'System',
        actionType: 'meeting_scheduled',
        entityType: 'Event',
        entityId: item._id,
      })),
    ].sort((a, b) => b.date - a.date).slice(0, 10);

    const conversionRate = newLeads > 0 ? Number(((convertedCustomers / newLeads) * 100).toFixed(1)) : 0;
    const pipelineCounts = new Map(pipelineRows.map((item) => [item._id, item.count]));

    res.json({
      success: true,
      data: {
        metrics: {
          // Keep the previous keys for API compatibility while the UI uses company-first terminology.
          totalLeads: totalCustomers + totalCompanies,
          totalCustomers,
          totalCompanies,
          totalMeetings: meetingsCompleted,
          newLeads,
          convertedCustomers,
          conversionRate,
          activePipelineValue: pipelineValueRows[0]?.total || 0,
          wonRevenue: wonRevenueRows[0]?.total || 0,
          followUpsDue,
          meetingsCompleted,
        },
        charts: {
          trend: mergeTrendRows(createdTrendRows, convertedTrendRows),
          pipeline: PIPELINE_STATUSES.map((status) => ({ status, count: pipelineCounts.get(status) || 0 })),
          sources: sourceRows.map((item) => ({ source: item._id, count: item.count })),
        },
        recentActivities,
      },
    });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const getSalesReport = async (req, res) => {
  try {
    res.json({ success: true, data: await getSalesReportData(await scopedReportQuery(req)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const getSalesPerformance = async (req, res) => {
  try {
    res.json({ success: true, data: await getSalesPerformanceData(await scopedReportQuery(req)) });
  } catch (error) {
    res.status(error.statusCode || 500).json({ success: false, message: error.message });
  }
};

export const getUserReport = async (req, res) => {
  try {
    res.json({ success: true, data: await getUserReportData(await scopedReportQuery(req)) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getMeetingReport = async (req, res) => {
  try {
    res.json({ success: true, data: await getMeetingReportData(await scopedReportQuery(req)) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

const handleExportError = (res, error) => {
  if (res.headersSent) return res.end();
  return res.status(500).json({ success: false, message: error.message });
};

export const exportSalesReport = async (req, res) => {
  try {
    const query = await scopedReportQuery(req);
    const rows = Company.aggregate([
      ...buildSalesReportPipeline({
        period: query.period,
        startDate: query.startDate,
        endDate: query.endDate,
        status: query.status,
        owner: query.owner,
        source: query.source,
        search: query.search,
        visibleUserIds: query._visibleUserIds,
      }),
      { $sort: { createdAt: -1, id: -1 } },
    ]).cursor({ batchSize: 250 });
    await streamCsv({
      res,
      filename: 'sales-report.csv',
      columns: [
        { label: 'Company', value: 'company' },
        { label: 'Primary Contact', value: 'contact' },
        { label: 'Sales Owner', value: 'owner' },
        { label: 'Status', value: 'status' },
        { label: 'Lead Source', value: 'source' },
        { label: 'Deal Value', value: 'dealValue' },
        { label: 'Expected Closing Date', value: 'expectedClosingDate' },
        { label: 'Converted Date', value: 'convertedAt' },
        { label: 'Last Activity', value: 'lastActivityAt' },
        { label: 'Created At', value: 'createdAt' },
      ],
      rows,
    });
  } catch (error) {
    handleExportError(res, error);
  }
};

export const exportUserReport = async (req, res) => {
  try {
    const rows = await getUserReportData(await scopedReportQuery(req));
    await streamCsv({
      res,
      filename: 'user-report.csv',
      columns: [
        { label: 'User Name', value: 'name' },
        { label: 'Email', value: 'email' },
        { label: 'Role', value: 'role' },
        { label: 'Leads Created', value: 'leadsCreated' },
        { label: 'Meetings Completed', value: 'meetingsCompleted' },
        { label: 'Joined At', value: 'joinedAt' },
      ],
      rows,
    });
  } catch (error) {
    handleExportError(res, error);
  }
};

export const exportMeetingReport = async (req, res) => {
  try {
    const rows = await getMeetingReportData(await scopedReportQuery(req));
    await streamCsv({
      res,
      filename: 'meeting-report.csv',
      columns: [
        { label: 'Meeting Title', value: 'title' },
        { label: 'Organizer', value: 'organizer' },
        { label: 'Status', value: 'status' },
        { label: 'Duration Minutes', value: 'durationMinutes' },
        { label: 'Has Summary', value: (row) => row.hasSummary ? 'Yes' : 'No' },
        { label: 'Scheduled Date', value: 'date' },
      ],
      rows,
    });
  } catch (error) {
    handleExportError(res, error);
  }
};
