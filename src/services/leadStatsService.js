import Customer from '../models/Customer.js';
import Company from '../models/Company.js';
import LeadStatusHistory from '../models/LeadStatusHistory.js';
import { isAdminUser, normalizeRole } from '../utils/hierarchy.js';
import {
  buildLeadStatsCacheKey,
  isFeatureEnabled,
  withSafeCache,
} from './cacheService.js';
import { resolveLeadVisibility } from './leadAccessService.js';

const TRACKED_STATUSES = ['Demo follow-up', 'Demo Scheduled', 'Follow Up', 'Committed', 'Converted', 'Not Interested'];
const INDIA_OFFSET = '+05:30';

export const emptyLeadStats = () => ({
  totalLeads: 0,
  demoFollowUp: 0,
  demoScheduled: 0,
  interested: 0,
  notInterested: 0,
  committed: 0,
  converted: 0,
  followUp: 0,
  today: {
    demoFollowUp: 0,
    demoScheduled: 0,
    followUp: 0,
    committed: 0,
    converted: 0,
    notInterested: 0,
  },
});

const visibilityQuery = (user) => (isAdminUser(user) ? {} : { assignedTo: user._id });

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
const nextDay = (date) => new Date(date.getTime() + 24 * 60 * 60 * 1000);

const rangeForFilters = ({ period = 'today', startDate, endDate, month, year }) => {
  if (period === 'all') return null;
  if (period === 'today') {
    const start = indiaDayStart(indiaDateString());
    return { start, end: nextDay(start) };
  }
  if (period === 'date') {
    if (!startDate || !endDate) throw Object.assign(new Error('Start date and end date are required'), { statusCode: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
      throw Object.assign(new Error('Start date and end date are invalid'), { statusCode: 400 });
    }
    const start = indiaDayStart(startDate);
    const selectedEnd = indiaDayStart(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(selectedEnd.getTime()) || start > selectedEnd) {
      throw Object.assign(new Error('Start date and end date are invalid'), { statusCode: 400 });
    }
    return { start, end: nextDay(selectedEnd) };
  }
  if (period === 'month') {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) throw Object.assign(new Error('Month is required'), { statusCode: 400 });
    const [selectedYear, selectedMonth] = month.split('-').map(Number);
    if (selectedMonth < 1 || selectedMonth > 12) throw Object.assign(new Error('Month is required'), { statusCode: 400 });
    const start = new Date(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01T00:00:00.000${INDIA_OFFSET}`);
    const nextMonthYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
    const nextMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
    const end = new Date(`${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00.000${INDIA_OFFSET}`);
    return { start, end };
  }
  if (period === 'year') {
    const selectedYear = Number(year);
    if (!selectedYear || selectedYear < 1900 || selectedYear > 2100) throw Object.assign(new Error('Year is required'), { statusCode: 400 });
    return {
      start: new Date(`${selectedYear}-01-01T00:00:00.000${INDIA_OFFSET}`),
      end: new Date(`${selectedYear + 1}-01-01T00:00:00.000${INDIA_OFFSET}`),
    };
  }
  return null;
};

const todayRange = () => rangeForFilters({ period: 'today' });

export const buildLeadStatsMatch = (user, filters, visibilityOverride) => {
  const matchStage = { ...(visibilityOverride || visibilityQuery(user)) };
  const range = rangeForFilters(filters);
  if (range) matchStage.createdAt = { $gte: range.start, $lt: range.end };
  return matchStage;
};

const applyGroupedCounts = (result, grouped) => {
  const keyByStatus = {
    'Demo Scheduled': 'demoScheduled',
    Interested: 'interested',
    'Not Interested': 'notInterested',
    Committed: 'committed',
    Converted: 'converted',
    'Demo follow-up': 'demoFollowUp',
    'Follow Up': 'followUp',
  };
  grouped.forEach(({ _id, count }) => {
    result.totalLeads += count;
    const key = keyByStatus[_id];
    if (key) result[key] += count;
  });
};

const groupedStatusPipeline = (matchStage) => [
  { $match: matchStage },
  { $group: { _id: '$leadStatus', count: { $sum: 1 } } },
];

const dateInRange = (dateExpression, range) => (
  range
    ? { $and: [{ $gte: [dateExpression, range.start] }, { $lt: [dateExpression, range.end] }] }
    : true
);

const companyStatusDateExpression = (status) => {
  const statusActivityDate = { $ifNull: ['$leadStatusChangedAt', '$createdAt'] };
  if (status === 'Demo follow-up') return '$statusDetails.demoFollowUpDateTime';
  if (status === 'Demo Scheduled') {
    return {
      $ifNull: [
        '$scheduledDateTime',
        { $ifNull: ['$statusDetails.demoDateTime', '$followTypeDate'] },
      ],
    };
  }
  if (status === 'Follow Up') return { $ifNull: ['$followUpDateTime', '$followTypeDate'] };
  if (status === 'Converted') return { $ifNull: ['$statusDetails.convertedAt', statusActivityDate] };
  return statusActivityDate;
};

export const buildCompanyStatusPeriodFilter = (status, filters) => {
  if (!status || status === 'all' || !filters.period || filters.period === 'all') return {};
  const range = rangeForFilters(filters);
  return { $expr: dateInRange(companyStatusDateExpression(status), range) };
};

const companyPeriodStatsPipeline = (visibility, range) => {
  const statusCount = (status) => ({
    $sum: {
      $cond: [
        { $and: [{ $eq: ['$leadStatus', status] }, dateInRange(companyStatusDateExpression(status), range)] },
        1,
        0,
      ],
    },
  });

  return [
    { $match: visibility },
    {
      $group: {
        _id: null,
        totalLeads: { $sum: 1 },
        demoScheduled: statusCount('Demo Scheduled'),
        demoFollowUp: statusCount('Demo follow-up'),
        followUp: statusCount('Follow Up'),
        interested: statusCount('Interested'),
        notInterested: statusCount('Not Interested'),
        committed: statusCount('Committed'),
        converted: statusCount('Converted'),
      },
    },
  ];
};

const historyVisibilityLookup = (from, as, matchStage) => ({
  $lookup: {
    from,
    let: { leadId: '$lead' },
    pipeline: [
      { $match: { ...matchStage, $expr: { $eq: ['$_id', '$$leadId'] } } },
      { $limit: 1 },
    ],
    as,
  },
});

export const calculateLeadStatsAggregated = async (user, filters, visibilityOverride) => {
  const matchStage = buildLeadStatsMatch(user, filters, visibilityOverride);
  const { start, end } = todayRange();
  if (filters.type === 'Company') {
    const { createdAt: periodCreatedAt, ...visibility } = matchStage;
    const periodRange = periodCreatedAt
      ? { start: periodCreatedAt.$gte, end: periodCreatedAt.$lt }
      : null;
    const [companyPeriodStats, todayDemo, todayHistory] = await Promise.all([
      Company.aggregate(companyPeriodStatsPipeline(visibility, periodRange)),
      Company.countDocuments({ ...visibility, leadStatus: 'Demo Scheduled', scheduledDateTime: { $gte: start, $lt: end } }),
      LeadStatusHistory.aggregate([
        {
          $match: {
            leadModel: 'Company',
            newStatus: { $in: TRACKED_STATUSES },
            changedAt: { $gte: start, $lt: end },
          },
        },
        historyVisibilityLookup(Company.collection.name, 'visibleCompany', visibility),
        { $match: { $expr: { $gt: [{ $size: '$visibleCompany' }, 0] } } },
        { $group: { _id: '$newStatus', count: { $sum: 1 } } },
      ]),
    ]);
    const result = emptyLeadStats();
    Object.assign(result, companyPeriodStats[0] || {});
    delete result._id;
    result.today.demoScheduled = todayDemo;
    const todayKey = {
      'Demo follow-up': 'demoFollowUp',
      'Follow Up': 'followUp',
      Committed: 'committed',
      Converted: 'converted',
      'Not Interested': 'notInterested',
    };
    todayHistory.forEach(({ _id, count }) => {
      if (todayKey[_id]) result.today[todayKey[_id]] = count;
    });
    return result;
  }
  const [customerGroups, companyGroups, todayDemo, todayHistory] = await Promise.all([
    Customer.aggregate(groupedStatusPipeline(matchStage)),
    Company.aggregate(groupedStatusPipeline(matchStage)),
    Promise.all([
      Customer.countDocuments({ ...matchStage, scheduledDateTime: { $gte: start, $lt: end } }),
      Company.countDocuments({ ...matchStage, scheduledDateTime: { $gte: start, $lt: end } }),
    ]),
    LeadStatusHistory.aggregate([
      {
        $match: {
          leadModel: { $in: ['Customer', 'Company'] },
          newStatus: { $in: TRACKED_STATUSES },
          changedAt: { $gte: start, $lt: end },
        },
      },
      historyVisibilityLookup(Customer.collection.name, 'visibleCustomer', matchStage),
      historyVisibilityLookup(Company.collection.name, 'visibleCompany', matchStage),
      {
        $match: {
          $expr: {
            $or: [
              { $and: [{ $eq: ['$leadModel', 'Customer'] }, { $gt: [{ $size: '$visibleCustomer' }, 0] }] },
              { $and: [{ $eq: ['$leadModel', 'Company'] }, { $gt: [{ $size: '$visibleCompany' }, 0] }] },
            ],
          },
        },
      },
      { $group: { _id: '$newStatus', count: { $sum: 1 } } },
    ]),
  ]);

  const result = emptyLeadStats();
  applyGroupedCounts(result, customerGroups);
  applyGroupedCounts(result, companyGroups);
  result.today.demoScheduled = todayDemo[0] + todayDemo[1];
  const todayKey = {
    'Demo follow-up': 'demoFollowUp',
    'Follow Up': 'followUp',
    Committed: 'committed',
    Converted: 'converted',
    'Not Interested': 'notInterested',
  };
  todayHistory.forEach(({ _id, count }) => {
    if (todayKey[_id]) result.today[todayKey[_id]] = count;
  });
  return result;
};

export const calculateLeadStatsLegacy = async (user, filters, visibilityOverride) => {
  const matchStage = buildLeadStatsMatch(user, filters, visibilityOverride);
  const result = emptyLeadStats();
  if (filters.type === 'Company') {
    const { createdAt: periodCreatedAt, ...visibility } = matchStage;
    const periodRange = periodCreatedAt
      ? { start: periodCreatedAt.$gte, end: periodCreatedAt.$lt }
      : null;
    const statusActivityDate = { $ifNull: ['$leadStatusChangedAt', '$createdAt'] };
    const countStatus = (status, dateExpression = statusActivityDate) => Company.countDocuments({
      ...visibility,
      leadStatus: status,
      ...(periodRange ? { $expr: dateInRange(dateExpression, periodRange) } : {}),
    });
    const [total, demoFollowUp, demoScheduled, interested, notInterested, committed, converted, followUp] = await Promise.all([
      Company.countDocuments(visibility),
      countStatus('Demo follow-up', '$statusDetails.demoFollowUpDateTime'),
      countStatus('Demo Scheduled', {
        $ifNull: [
          '$scheduledDateTime',
          { $ifNull: ['$statusDetails.demoDateTime', '$followTypeDate'] },
        ],
      }),
      countStatus('Interested'),
      countStatus('Not Interested'),
      countStatus('Committed'),
      countStatus('Converted', { $ifNull: ['$statusDetails.convertedAt', statusActivityDate] }),
      countStatus('Follow Up', { $ifNull: ['$followUpDateTime', '$followTypeDate'] }),
    ]);
    result.totalLeads = total;
    Object.assign(result, {
      demoFollowUp,
      demoScheduled,
      interested,
      notInterested,
      committed,
      converted,
      followUp,
    });
    return result;
  }
  const countByStatus = async (status) => {
    const [customers, companies] = await Promise.all([
      Customer.countDocuments({ ...matchStage, leadStatus: status }),
      Company.countDocuments({ ...matchStage, leadStatus: status }),
    ]);
    return customers + companies;
  };
  const [customerCount, companyCount, ...statusCounts] = await Promise.all([
    Customer.countDocuments(matchStage),
    Company.countDocuments(matchStage),
    ...['Demo follow-up', 'Demo Scheduled', 'Interested', 'Not Interested', 'Committed', 'Converted', 'Follow Up'].map(countByStatus),
  ]);
  result.totalLeads = customerCount + companyCount;
  [
    'demoFollowUp',
    'demoScheduled',
    'interested',
    'notInterested',
    'committed',
    'converted',
    'followUp',
  ].forEach((key, index) => { result[key] = statusCounts[index]; });

  const { start, end } = todayRange();
  const visibleLeadIds = [
    ...(await Customer.find(matchStage).select('_id').lean()).map((lead) => lead._id),
    ...(await Company.find(matchStage).select('_id').lean()).map((lead) => lead._id),
  ];
  const [todayDemo, todayHistory] = await Promise.all([
    Promise.all([
      Customer.countDocuments({ ...matchStage, scheduledDateTime: { $gte: start, $lt: end } }),
      Company.countDocuments({ ...matchStage, scheduledDateTime: { $gte: start, $lt: end } }),
    ]),
    LeadStatusHistory.aggregate([
      { $match: { lead: { $in: visibleLeadIds }, newStatus: { $in: TRACKED_STATUSES }, changedAt: { $gte: start, $lt: end } } },
      { $group: { _id: '$newStatus', count: { $sum: 1 } } },
    ]),
  ]);
  result.today.demoScheduled = todayDemo[0] + todayDemo[1];
  const todayKey = {
    'Demo follow-up': 'demoFollowUp',
    'Follow Up': 'followUp',
    Committed: 'committed',
    Converted: 'converted',
    'Not Interested': 'notInterested',
  };
  todayHistory.forEach(({ _id, count }) => {
    if (todayKey[_id]) result.today[todayKey[_id]] = count;
  });
  return result;
};

export const getCachedLeadStats = async (user, filters) => {
  const useAggregation = isFeatureEnabled('LEAD_STATS_AGGREGATION_V2');
  const visibility = await resolveLeadVisibility(user);
  const key = await buildLeadStatsCacheKey({
    userId: user._id.toString(),
    role: normalizeRole(user.role),
    filters: {
      ...filters,
      implementation: useAggregation ? 'aggregation-demo-follow-up-date' : 'legacy-demo-follow-up-date',
      accessScope: visibility.scope,
      visibleUserIds: visibility.userIds.map(String).sort(),
    },
  });
  const result = await withSafeCache({ key }, () => (
    useAggregation
      ? calculateLeadStatsAggregated(user, filters, visibility.query)
      : calculateLeadStatsLegacy(user, filters, visibility.query)
  ));
  return {
    ...result,
    queryCount: filters.type === 'Company'
      ? (useAggregation ? 3 : 8)
      : (useAggregation ? 5 : 23),
  };
};
