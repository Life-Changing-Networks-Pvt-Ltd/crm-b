import Customer from '../models/Customer.js';
import Company from '../models/Company.js';
import { isAdminUser, normalizeRole } from '../utils/hierarchy.js';
import {
  buildDashboardMetricsCacheKey,
  isFeatureEnabled,
  withSafeCache,
} from './cacheService.js';
import { resolveLeadVisibility } from './leadAccessService.js';

const INDIA_OFFSET = '+05:30';

export const PIPELINE_STATUSES = [
  'New',
  'Demo Scheduled',
  'Demo follow-up',
  'Interested',
  'Not Interested',
  'Committed',
  'Converted',
  'Follow Up',
];

export const emptyDashboardMetrics = () => ({
  totalCompanyLeads: 0,
  new: 0,
  demoScheduled: 0,
  demoFollowUp: 0,
  interested: 0,
  notInterested: 0,
  committed: 0,
  converted: 0,
  followUp: 0,
});

const indiaDateString = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const indiaDayStart = (date) => new Date(`${date}T00:00:00.000${INDIA_OFFSET}`);
const nextDay = (date) => new Date(date.getTime() + 24 * 60 * 60 * 1000);

const applyDashboardDateRange = (matchStage, {
  period = 'today', startDate, endDate, month, year,
}) => {
  if (period === 'all') return matchStage;

  let start;
  let end;
  if (period === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) {
      throw Object.assign(new Error('Start date and end date are required'), { statusCode: 400 });
    }
    start = indiaDayStart(startDate);
    const selectedEnd = indiaDayStart(endDate);
    if (start > selectedEnd) throw Object.assign(new Error('Start date cannot be after end date'), { statusCode: 400 });
    end = nextDay(selectedEnd);
  } else if (period === 'month') {
    if (!/^\d{4}-\d{2}$/.test(month || '')) throw Object.assign(new Error('Month is required'), { statusCode: 400 });
    const [selectedYear, selectedMonth] = month.split('-').map(Number);
    if (selectedMonth < 1 || selectedMonth > 12) throw Object.assign(new Error('Month is invalid'), { statusCode: 400 });
    start = indiaDayStart(`${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`);
    const nextMonthYear = selectedMonth === 12 ? selectedYear + 1 : selectedYear;
    const nextMonth = selectedMonth === 12 ? 1 : selectedMonth + 1;
    end = indiaDayStart(`${nextMonthYear}-${String(nextMonth).padStart(2, '0')}-01`);
  } else if (period === 'year') {
    const selectedYear = Number(year);
    if (!selectedYear || selectedYear < 1900 || selectedYear > 2100) {
      throw Object.assign(new Error('Year is required'), { statusCode: 400 });
    }
    start = indiaDayStart(`${selectedYear}-01-01`);
    end = indiaDayStart(`${selectedYear + 1}-01-01`);
  } else {
    start = indiaDayStart(indiaDateString());
    end = nextDay(start);
  }

  return { ...matchStage, createdAt: { $gte: start, $lt: end } };
};

export const buildDashboardMetricMatch = (user, filters, visibilityOverride) => {
  const visibility = visibilityOverride || (isAdminUser(user) ? {} : { assignedTo: user._id });
  return applyDashboardDateRange(visibility, filters);
};

export const buildDemoFollowUpDashboardMatch = (matchStage) => {
  if (!matchStage.createdAt) return matchStage;
  const { createdAt, ...visibility } = matchStage;
  return {
    ...visibility,
    $or: [
      { leadStatus: { $ne: 'Demo follow-up' }, createdAt },
      { leadStatus: 'Demo follow-up', 'statusDetails.demoFollowUpDateTime': createdAt },
    ],
  };
};

const mapGroupedMetrics = (customerStats, companyStats, totalCompanyLeads) => {
  const counts = Object.fromEntries(PIPELINE_STATUSES.map((status) => [status, 0]));
  [...customerStats, ...companyStats].forEach(({ _id, count }) => {
    const status = _id || 'New';
    if (counts[status] !== undefined) counts[status] += count;
  });

  return {
    totalCompanyLeads,
    new: counts.New,
    demoScheduled: counts['Demo Scheduled'],
    demoFollowUp: counts['Demo follow-up'],
    interested: counts.Interested,
    notInterested: counts['Not Interested'],
    committed: counts.Committed,
    converted: counts.Converted,
    followUp: counts['Follow Up'],
  };
};

export const calculateDashboardMetricsAggregated = async (user, filters, visibilityOverride) => {
  const matchStage = buildDashboardMetricMatch(user, filters, visibilityOverride);
  const visibility = { ...matchStage };
  delete visibility.createdAt;
  const groupPipeline = [
    { $match: buildDemoFollowUpDashboardMatch(matchStage) },
    { $group: { _id: { $ifNull: ['$leadStatus', 'New'] }, count: { $sum: 1 } } },
  ];
  const [customerStats, companyStats, totalCompanyLeads] = await Promise.all([
    Customer.aggregate(groupPipeline),
    Company.aggregate(groupPipeline),
    Company.countDocuments(visibility),
  ]);
  return mapGroupedMetrics(customerStats, companyStats, totalCompanyLeads);
};

export const calculateDashboardMetricsLegacy = async (user, filters, visibilityOverride) => {
  const matchStage = buildDashboardMetricMatch(user, filters, visibilityOverride);
  const visibility = { ...matchStage };
  delete visibility.createdAt;
  const metrics = emptyDashboardMetrics();
  const statusToKey = {
    New: 'new',
    'Demo Scheduled': 'demoScheduled',
    'Demo follow-up': 'demoFollowUp',
    Interested: 'interested',
    'Not Interested': 'notInterested',
    Committed: 'committed',
    Converted: 'converted',
    'Follow Up': 'followUp',
  };
  const [totalCompanyLeads, values] = await Promise.all([
    Company.countDocuments(visibility),
    Promise.all(PIPELINE_STATUSES.map(async (status) => {
      const statusMatch = status === 'New'
        ? { $or: [{ leadStatus: 'New' }, { leadStatus: null }] }
        : { leadStatus: status };
      const [customers, companies] = await Promise.all([
        Customer.countDocuments(status === 'Demo follow-up' && matchStage.createdAt
          ? { ...visibility, ...statusMatch, 'statusDetails.demoFollowUpDateTime': matchStage.createdAt }
          : { ...matchStage, ...statusMatch }),
        Company.countDocuments(status === 'Demo follow-up' && matchStage.createdAt
          ? { ...visibility, ...statusMatch, 'statusDetails.demoFollowUpDateTime': matchStage.createdAt }
          : { ...matchStage, ...statusMatch }),
      ]);
      return [statusToKey[status], customers + companies];
    })),
  ]);
  metrics.totalCompanyLeads = totalCompanyLeads;
  values.forEach(([key, count]) => {
    metrics[key] = count;
  });
  return metrics;
};

export const getDashboardMetrics = async (user, filters, access) => {
  const useAggregation = isFeatureEnabled('DASHBOARD_METRICS_V2');
  const visibility = await resolveLeadVisibility(user, access);
  const cacheKey = await buildDashboardMetricsCacheKey({
    userId: user._id.toString(),
    role: normalizeRole(user.role),
    period: filters.period || 'today',
    startDate: filters.startDate,
    endDate: filters.endDate,
    month: filters.month,
    year: filters.year,
    implementation: useAggregation ? 'aggregation-demo-follow-up-date' : 'legacy-demo-follow-up-date',
    accessScope: visibility.scope,
    visibleUserIds: visibility.userIds.map(String).sort(),
  });
  const result = await withSafeCache({ key: cacheKey }, () => (
    useAggregation
      ? calculateDashboardMetricsAggregated(user, filters, visibility.query)
      : calculateDashboardMetricsLegacy(user, filters, visibility.query)
  ));
  return { ...result, queryCount: useAggregation ? 3 : 17 };
};
