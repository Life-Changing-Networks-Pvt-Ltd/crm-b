import Company from '../models/Company.js';
import Customer from '../models/Customer.js';
import Event from '../models/Event.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { escapeRegex, pagedData, paginationMeta, parsePagination } from './listQueryService.js';

export const reportDateRange = (period, now = new Date()) => {
  if (!period || period === 'All') return null;
  let start;
  let end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (period === 'Today') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'This Week') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay());
    end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (period === 'This Month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    return null;
  }
  return { $gte: start, $lte: end };
};

const salesDateRange = ({ period, startDate, endDate }) => {
  if (period !== 'Date Range') return reportDateRange(period);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
    throw Object.assign(new Error('A valid start date and end date are required'), { statusCode: 400 });
  }
  const start = new Date(`${startDate}T00:00:00.000+05:30`);
  const end = new Date(`${endDate}T23:59:59.999+05:30`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    throw Object.assign(new Error('A valid start date and end date are required'), { statusCode: 400 });
  }
  return { $gte: start, $lte: end };
};

export const buildSalesReportMatch = ({ period, startDate, endDate, status, owner, source, search, visibleUserIds } = {}) => {
  const match = {};
  const dateRange = salesDateRange({ period, startDate, endDate });
  if (dateRange) match.createdAt = dateRange;
  if (status && status !== 'All') match.leadStatus = status;
  if (source && source !== 'All') match.leadSource = source;
  if (owner && owner !== 'All') {
    if (!mongoose.isValidObjectId(owner)) throw Object.assign(new Error('Invalid sales owner'), { statusCode: 400 });
    match.assignedTo = new mongoose.Types.ObjectId(owner);
  }
  if (search) {
    const value = new RegExp(escapeRegex(String(search).trim().slice(0, 100)), 'i');
    match.$and = [{ $or: [{ companyName: value }, { customerName: value }, { email1: value }, { mobileNo: value }] }];
  }
  if (Array.isArray(visibleUserIds)) {
    const visibility = { $or: [{ createdBy: { $in: visibleUserIds } }, { assignedTo: { $in: visibleUserIds } }] };
    match.$and = [...(match.$and || []), visibility];
  }
  return match;
};

const dealValueExpression = {
  $switch: {
    branches: [
      { case: { $eq: ['$leadStatus', 'Converted'] }, then: { $ifNull: ['$statusDetails.finalDealValue', 0] } },
      { case: { $eq: ['$leadStatus', 'Committed'] }, then: { $ifNull: ['$statusDetails.dealValue', 0] } },
    ],
    default: { $ifNull: ['$statusDetails.estimatedDealValue', 0] },
  },
};

export const buildSalesReportPipeline = (filters = {}) => {
  const match = buildSalesReportMatch(filters);
  return [
    { $match: match },
    { $lookup: { from: User.collection.name, localField: 'assignedTo', foreignField: '_id', as: 'ownerUsers' } },
    { $lookup: { from: User.collection.name, localField: 'createdBy', foreignField: '_id', as: 'creatorUsers' } },
    {
      $project: {
        _id: 0,
        id: '$_id',
        company: '$companyName',
        contact: { $ifNull: ['$customerName', '—'] },
        status: { $ifNull: ['$leadStatus', 'New'] },
        source: { $ifNull: ['$leadSource', 'Direct'] },
        owner: { $ifNull: [{ $arrayElemAt: ['$ownerUsers.name', 0] }, { $ifNull: [{ $arrayElemAt: ['$creatorUsers.name', 0] }, 'System'] }] },
        ownerId: { $arrayElemAt: ['$assignedTo', 0] },
        dealValue: dealValueExpression,
        expectedClosingDate: { $ifNull: ['$statusDetails.expectedClosingDate', '$statusDetails.expectedCompletionDate'] },
        convertedAt: '$statusDetails.convertedAt',
        lastActivityAt: { $ifNull: ['$leadStatusChangedAt', '$updatedAt'] },
        createdAt: 1,
      },
    },
  ];
};

export const getSalesReportData = async (query = {}) => {
  const options = {
    period: query.period,
    startDate: query.startDate,
    endDate: query.endDate,
    status: query.status,
    owner: query.owner,
    source: query.source,
    search: query.search,
    visibleUserIds: query._visibleUserIds,
  };
  const match = buildSalesReportMatch(options);
  const visibilityMatch = buildSalesReportMatch({ visibleUserIds: query._visibleUserIds });
  const { page, limit, skip } = parsePagination(query);
  const dateFormat = query.period === 'All' ? '%Y-%m' : '%Y-%m-%d';
  const [pageResult, metricRows, pipelineRows, trendRows, ownerRows, sourceRows] = await Promise.all([
    Company.aggregate([
      ...buildSalesReportPipeline(options),
      { $sort: { createdAt: -1, id: -1 } },
      { $facet: { items: [{ $skip: skip }, { $limit: limit }], total: [{ $count: 'count' }] } },
    ]),
    Company.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        newLeads: { $sum: 1 },
        activeDeals: { $sum: { $cond: [{ $not: [{ $in: ['$leadStatus', ['Converted', 'Not Interested']] }] }, 1, 0] } },
        pipelineValue: { $sum: { $cond: [{ $in: ['$leadStatus', ['Interested', 'Committed']] }, dealValueExpression, 0] } },
        convertedCustomers: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, 1, 0] } },
        wonRevenue: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, { $ifNull: ['$statusDetails.finalDealValue', 0] }, 0] } },
      } },
    ]),
    Company.aggregate([{ $match: match }, { $group: { _id: { $ifNull: ['$leadStatus', 'New'] }, count: { $sum: 1 } } }]),
    Company.aggregate([
      { $match: match },
      { $group: {
        _id: { $dateToString: { format: dateFormat, date: '$createdAt', timezone: 'Asia/Kolkata' } },
        newLeads: { $sum: 1 },
        converted: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, 1, 0] } },
        revenue: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, { $ifNull: ['$statusDetails.finalDealValue', 0] }, 0] } },
      } },
      { $sort: { _id: 1 } },
    ]),
    Company.aggregate([
      { $match: visibilityMatch }, { $unwind: '$assignedTo' },
      { $group: { _id: '$assignedTo' } },
      { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', as: 'user' } },
      { $project: { _id: 0, id: '$_id', name: { $arrayElemAt: ['$user.name', 0] } } },
      { $sort: { name: 1 } },
    ]),
    Company.aggregate([
      { $match: visibilityMatch },
      { $group: { _id: { $ifNull: ['$leadSource', 'Direct'] }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const result = pageResult[0] || { items: [], total: [] };
  const total = result.total?.[0]?.count || 0;
  const metrics = metricRows[0] || { newLeads: 0, activeDeals: 0, pipelineValue: 0, convertedCustomers: 0, wonRevenue: 0 };
  metrics.conversionRate = metrics.newLeads ? Number(((metrics.convertedCustomers / metrics.newLeads) * 100).toFixed(1)) : 0;
  metrics.averageDealValue = metrics.convertedCustomers ? Math.round(metrics.wonRevenue / metrics.convertedCustomers) : 0;
  const pipelineMap = new Map(pipelineRows.map((row) => [row._id, row.count]));
  const statuses = ['New', 'Follow Up', 'Interested', 'Demo Scheduled', 'Demo follow-up', 'Committed', 'Converted', 'Not Interested'];
  return {
    items: result.items || [],
    pagination: paginationMeta({ page, limit, total }),
    metrics,
    charts: {
      pipeline: statuses.map((status) => ({ status, count: pipelineMap.get(status) || 0 })),
      trend: trendRows.map((row) => ({ period: row._id, newLeads: row.newLeads, converted: row.converted, revenue: row.revenue })),
    },
    facets: { owners: ownerRows.filter((row) => row.name), sources: sourceRows.map((row) => row._id) },
  };
};

export const buildSalesPerformancePipeline = (query = {}) => {
  const options = {
    period: query.period,
    startDate: query.startDate,
    endDate: query.endDate,
    status: query.status,
    owner: query.owner,
    source: query.source,
    search: query.search,
    visibleUserIds: query._visibleUserIds,
  };
  const match = buildSalesReportMatch(options);
  const { limit, skip } = parsePagination(query);
  const topLimit = Number.parseInt(query.topLimit, 10) === 20 ? 20 : 10;
  const performanceSearch = String(query.performanceSearch || '').trim().slice(0, 100);
  const leaderboardSearch = performanceSearch
    ? [{ $match: { owner: new RegExp(escapeRegex(performanceSearch), 'i') } }]
    : [];
  const sort = { converted: -1, revenue: -1, assigned: -1, owner: 1 };
  return [
    { $match: match },
    { $group: {
      _id: { $ifNull: [{ $arrayElemAt: ['$assignedTo', 0] }, '$createdBy'] },
      assigned: { $sum: 1 },
      activeDeals: { $sum: { $cond: [{ $not: [{ $in: ['$leadStatus', ['Converted', 'Not Interested']] }] }, 1, 0] } },
      converted: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, 1, 0] } },
      revenue: { $sum: { $cond: [{ $eq: ['$leadStatus', 'Converted'] }, { $ifNull: ['$statusDetails.finalDealValue', 0] }, 0] } },
    } },
    { $lookup: { from: User.collection.name, localField: '_id', foreignField: '_id', as: 'user' } },
    { $project: {
      _id: 0,
      ownerId: '$_id',
      owner: { $ifNull: [{ $arrayElemAt: ['$user.name', 0] }, 'System'] },
      assigned: 1,
      activeDeals: 1,
      converted: 1,
      revenue: 1,
      conversionRate: {
        $cond: [{ $gt: ['$assigned', 0] }, { $round: [{ $multiply: [{ $divide: ['$converted', '$assigned'] }, 100] }, 1] }, 0],
      },
    } },
    { $facet: {
      chart: [{ $sort: sort }, { $limit: topLimit }],
      items: [...leaderboardSearch, { $sort: sort }, { $skip: skip }, { $limit: limit }],
      total: [...leaderboardSearch, { $count: 'count' }],
    } },
  ];
};

export const getSalesPerformanceData = async (query = {}) => {
  const { page, limit } = parsePagination(query);
  const rows = await Company.aggregate(buildSalesPerformancePipeline(query));
  const result = rows[0] || { chart: [], items: [], total: [] };
  const total = result.total?.[0]?.count || 0;
  return {
    chart: result.chart || [],
    items: result.items || [],
    pagination: paginationMeta({ page, limit, total }),
  };
};

const countsByUser = (rows) => new Map(rows.map((row) => [String(row._id), row.count]));

export const mergeUserReportRows = ({ users, customerCounts, companyCounts, meetingCounts }) => {
  const customerMap = countsByUser(customerCounts);
  const companyMap = countsByUser(companyCounts);
  const meetingMap = countsByUser(meetingCounts);
  return users.map((user) => ({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    leadsCreated: (customerMap.get(String(user._id)) || 0) + (companyMap.get(String(user._id)) || 0),
    meetingsCompleted: meetingMap.get(String(user._id)) || 0,
    joinedAt: user.createdAt,
  }));
};

export const getUserReportData = async (query = {}) => {
  const filter = {};
  if (Array.isArray(query._visibleUserIds)) filter._id = { $in: query._visibleUserIds };
  const dateRange = reportDateRange(query.period);
  if (dateRange) filter.createdAt = dateRange;
  const paginationRequested = query.page !== undefined || query.limit !== undefined;
  const { page, limit, skip } = parsePagination(query);
  const userQuery = User.find(filter)
    .select('name email role createdAt')
    .lean();
  if (paginationRequested) userQuery.sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit);
  const [users, total] = await Promise.all([
    userQuery,
    paginationRequested ? User.countDocuments(filter) : Promise.resolve(0),
  ]);
  const userIds = users.map((user) => user._id);
  const groupPipeline = (extraMatch = {}) => [
    { $match: { createdBy: { $in: userIds }, ...extraMatch } },
    { $group: { _id: '$createdBy', count: { $sum: 1 } } },
  ];
  const [customerCounts, companyCounts, meetingCounts] = userIds.length
    ? await Promise.all([
      Customer.aggregate(groupPipeline()),
      Company.aggregate(groupPipeline()),
      Event.aggregate(groupPipeline({ type: 'Meeting', status: 'Completed' })),
    ])
    : [[], [], []];
  const rows = mergeUserReportRows({ users, customerCounts, companyCounts, meetingCounts });
  return paginationRequested ? pagedData(rows, paginationMeta({ page, limit, total })) : rows;
};

export const getMeetingReportData = async (query = {}) => {
  const filter = { type: 'Meeting' };
  if (Array.isArray(query._visibleUserIds)) filter.createdBy = { $in: query._visibleUserIds };
  if (query.status && query.status !== 'All') filter.status = query.status;
  const dateRange = reportDateRange(query.period);
  if (dateRange) filter.date = dateRange;
  const paginationRequested = query.page !== undefined || query.limit !== undefined;
  const { page, limit, skip } = parsePagination(query);
  const meetingQuery = Event.find(filter)
    .select('title date status report.durationMinutes report.summary createdBy createdAt')
    .populate('createdBy', 'name')
    .sort({ createdAt: -1, _id: -1 })
    .lean();
  if (paginationRequested) meetingQuery.skip(skip).limit(limit);
  const [meetings, total] = await Promise.all([
    meetingQuery,
    paginationRequested ? Event.countDocuments(filter) : Promise.resolve(0),
  ]);
  const rows = meetings.map((meeting) => ({
    id: meeting._id,
    title: meeting.title,
    date: meeting.date,
    status: meeting.status,
    durationMinutes: meeting.report?.durationMinutes || 0,
    hasSummary: Boolean(meeting.report?.summary),
    organizer: meeting.createdBy?.name || 'System',
  }));
  return paginationRequested ? pagedData(rows, paginationMeta({ page, limit, total })) : rows;
};
