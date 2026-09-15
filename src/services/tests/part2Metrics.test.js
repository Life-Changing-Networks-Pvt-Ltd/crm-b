import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Customer from '../../models/Customer.js';
import Company from '../../models/Company.js';
import Lead from '../../models/Lead.js';
import LeadStatusHistory from '../../models/LeadStatusHistory.js';
import { buildDashboardMetricMatch, calculateDashboardMetricsAggregated } from '../dashboardMetricsService.js';
import {
  buildCompanyStatusPeriodFilter,
  buildLeadStatsMatch,
  calculateLeadStatsAggregated,
  calculateLeadStatsLegacy,
} from '../leadStatsService.js';
import {
  getCacheMetrics,
  getCachedJsonMany,
  setCachedJsonMany,
  withSafeCache,
} from '../cacheService.js';

const admin = {
  _id: new mongoose.Types.ObjectId(),
  role: 'admin',
};

test('lead schemas reject the retired Prospective status', () => {
  assert.equal(Company.schema.path('leadStatus').enumValues.includes('Prospective'), false);
  assert.equal(Customer.schema.path('leadStatus').enumValues.includes('Prospective'), false);
  assert.equal(Lead.schema.path('status').enumValues.includes('Prospective'), false);
});

test('all lead models accept Demo follow-up and retain existing statuses', async () => {
  for (const [Model, field] of [[Company, 'leadStatus'], [Customer, 'leadStatus'], [Lead, 'status']]) {
    for (const status of ['Demo follow-up', 'Demo Scheduled', 'Follow Up', 'New']) {
      const lead = new Model({ [field]: status });
      await lead.validate([field]);
      assert.equal(lead[field], status);
    }
  }
});

test('dashboard aggregation preserves status mapping and null-as-New', { concurrency: false }, async () => {
  const originalCustomerAggregate = Customer.aggregate;
  const originalCompanyAggregate = Company.aggregate;
  const originalCompanyCount = Company.countDocuments;
  try {
    Customer.aggregate = async () => [
      { _id: null, count: 2 },
      { _id: 'Interested', count: 3 },
      { _id: 'Demo follow-up', count: 2 },
    ];
    Company.aggregate = async () => [
      { _id: 'New', count: 4 },
      { _id: 'Converted', count: 1 },
      { _id: 'Demo follow-up', count: 1 },
    ];
    Company.countDocuments = async (query) => {
      assert.equal(query.createdAt, undefined);
      return 7;
    };

    const metrics = await calculateDashboardMetricsAggregated(admin, { period: 'today' });
    assert.deepEqual(metrics, {
      totalCompanyLeads: 7,
      new: 6,
      demoScheduled: 0,
      demoFollowUp: 3,
      interested: 3,
      notInterested: 0,
      committed: 0,
      converted: 1,
      followUp: 0,
    });
  } finally {
    Customer.aggregate = originalCustomerAggregate;
    Company.aggregate = originalCompanyAggregate;
    Company.countDocuments = originalCompanyCount;
  }
});

test('dashboard custom date range uses complete Asia Kolkata calendar days', () => {
  const visibility = { assignedTo: admin._id };
  const match = buildDashboardMetricMatch(
    admin,
    { period: 'date', startDate: '2026-09-03', endDate: '2026-09-04' },
    visibility,
  );

  assert.deepEqual(visibility, { assignedTo: admin._id });
  assert.equal(match.createdAt.$gte.toISOString(), '2026-09-02T18:30:00.000Z');
  assert.equal(match.createdAt.$lt.toISOString(), '2026-09-04T18:30:00.000Z');
  assert.throws(
    () => buildDashboardMetricMatch(admin, { period: 'date', startDate: '2026-09-04', endDate: '2026-09-03' }),
    /cannot be after/,
  );
});

test('lead aggregation uses grouped counts and lookup visibility without loading ID arrays', { concurrency: false }, async () => {
  const originals = {
    customerAggregate: Customer.aggregate,
    companyAggregate: Company.aggregate,
    customerCount: Customer.countDocuments,
    companyCount: Company.countDocuments,
    historyAggregate: LeadStatusHistory.aggregate,
    customerFind: Customer.find,
    companyFind: Company.find,
  };
  let customerPipeline;
  let companyPipeline;
  let historyPipeline;
  try {
    Customer.aggregate = async (pipeline) => {
      customerPipeline = pipeline;
      return [{ _id: 'Interested', count: 2 }, { _id: null, count: 1 }];
    };
    Company.aggregate = async (pipeline) => {
      companyPipeline = pipeline;
      return [{ _id: 'Converted', count: 3 }, { _id: 'Demo follow-up', count: 2 }];
    };
    Customer.countDocuments = async () => 1;
    Company.countDocuments = async () => 2;
    LeadStatusHistory.aggregate = async (pipeline) => {
      historyPipeline = pipeline;
      return [{ _id: 'Follow Up', count: 4 }, { _id: 'Demo follow-up', count: 1 }];
    };
    Customer.find = () => { throw new Error('Customer.find must not be used by V2 stats'); };
    Company.find = () => { throw new Error('Company.find must not be used by V2 stats'); };

    const stats = await calculateLeadStatsAggregated(admin, { period: 'all' });
    assert.equal(stats.totalLeads, 8);
    assert.equal(stats.demoFollowUp, 2);
    assert.equal(stats.today.demoFollowUp, 1);
    assert.equal(stats.interested, 2);
    assert.equal(stats.converted, 3);
    assert.equal(stats.today.demoScheduled, 3);
    assert.equal(stats.today.followUp, 4);
    assert.ok(customerPipeline.some((stage) => stage.$group));
    assert.ok(companyPipeline.some((stage) => stage.$group));
    assert.equal(historyPipeline.filter((stage) => stage.$lookup).length, 2);
  } finally {
    Customer.aggregate = originals.customerAggregate;
    Company.aggregate = originals.companyAggregate;
    Customer.countDocuments = originals.customerCount;
    Company.countDocuments = originals.companyCount;
    LeadStatusHistory.aggregate = originals.historyAggregate;
    Customer.find = originals.customerFind;
    Company.find = originals.companyFind;
  }
});

test('company-only lead stats do not query customer records', { concurrency: false }, async () => {
  const originals = {
    customerAggregate: Customer.aggregate,
    companyAggregate: Company.aggregate,
    companyCount: Company.countDocuments,
    historyAggregate: LeadStatusHistory.aggregate,
  };
  let companyPipeline;
  try {
    Customer.aggregate = () => { throw new Error('Customer.aggregate must not run for company-only stats'); };
    Company.aggregate = async (pipeline) => {
      companyPipeline = pipeline;
      return [{
        totalLeads: 6,
        demoScheduled: 1,
        interested: 4,
        notInterested: 0,
        committed: 0,
        converted: 0,
        followUp: 2,
      }];
    };
    Company.countDocuments = async () => 1;
    LeadStatusHistory.aggregate = async () => [{ _id: 'Follow Up', count: 1 }];

    const assignedTo = new mongoose.Types.ObjectId();
    const stats = await calculateLeadStatsAggregated(
      { _id: assignedTo, role: 'employee' },
      { period: 'today', type: 'Company' },
      { assignedTo },
    );
    assert.equal(stats.totalLeads, 6);
    assert.equal(stats.interested, 4);
    assert.equal(stats.followUp, 2);
    assert.equal(stats.today.demoScheduled, 1);
    assert.equal(stats.today.followUp, 1);
    assert.deepEqual(companyPipeline[0], { $match: { assignedTo } });
    assert.deepEqual(companyPipeline[1].$group.totalLeads, { $sum: 1 });
    const pipelineText = JSON.stringify(companyPipeline);
    assert.match(pipelineText, /\$scheduledDateTime/);
    assert.match(pipelineText, /\$followUpDateTime/);
    assert.match(pipelineText, /\$followTypeDate/);
  } finally {
    Customer.aggregate = originals.customerAggregate;
    Company.aggregate = originals.companyAggregate;
    Company.countDocuments = originals.companyCount;
    LeadStatusHistory.aggregate = originals.historyAggregate;
  }
});

test('legacy company stats keep total leads independent of the selected period', { concurrency: false }, async () => {
  const originalCompanyCount = Company.countDocuments;
  const queries = [];
  try {
    Company.countDocuments = async (query) => {
      queries.push(query);
      return 1;
    };

    const assignedTo = new mongoose.Types.ObjectId();
    const stats = await calculateLeadStatsLegacy(
      { _id: assignedTo, role: 'employee' },
      { period: 'today', type: 'Company' },
      { assignedTo },
    );

    assert.equal(stats.totalLeads, 1);
    assert.equal(stats.demoFollowUp, 1);
    assert.ok(queries.some((query) => query.leadStatus === 'Demo follow-up'));
    assert.deepEqual(queries[0], { assignedTo });
    assert.equal('createdAt' in queries[0], false);
  } finally {
    Company.countDocuments = originalCompanyCount;
  }
});

test('lead date ranges use complete Asia Kolkata calendar days without mutating visibility', () => {
  const assignedTo = new mongoose.Types.ObjectId();
  const visibility = { assignedTo };
  const match = buildLeadStatsMatch(
    { _id: assignedTo, role: 'employee' },
    { period: 'date', startDate: '2026-09-03', endDate: '2026-09-04' },
    visibility,
  );

  assert.deepEqual(visibility, { assignedTo });
  assert.equal(match.createdAt.$gte.toISOString(), '2026-09-02T18:30:00.000Z');
  assert.equal(match.createdAt.$lt.toISOString(), '2026-09-04T18:30:00.000Z');
});

test('company list status filters use the same date fields as metric cards', () => {
  const filters = { period: 'date', startDate: '2026-09-26', endDate: '2026-09-26' };
  const followUp = JSON.stringify(buildCompanyStatusPeriodFilter('Follow Up', filters));
  const demo = JSON.stringify(buildCompanyStatusPeriodFilter('Demo Scheduled', filters));
  const interested = JSON.stringify(buildCompanyStatusPeriodFilter('Interested', filters));
  const converted = JSON.stringify(buildCompanyStatusPeriodFilter('Converted', filters));

  assert.match(followUp, /\$followUpDateTime/);
  assert.match(followUp, /\$followTypeDate/);
  assert.match(demo, /\$scheduledDateTime/);
  assert.match(demo, /\$statusDetails\.demoDateTime/);
  assert.match(interested, /\$leadStatusChangedAt/);
  assert.match(converted, /\$statusDetails\.convertedAt/);
  assert.deepEqual(buildCompanyStatusPeriodFilter('all', filters), {});
  assert.deepEqual(buildCompanyStatusPeriodFilter('Follow Up', { period: 'all' }), {});
});

test('lead filter validation rejects incomplete committed values', () => {
  assert.throws(
    () => buildLeadStatsMatch(admin, { period: 'month', month: '2026-' }),
    /Month is required/,
  );
  assert.throws(
    () => buildLeadStatsMatch(admin, { period: 'year', year: '20' }),
    /Year is required/,
  );
  assert.throws(
    () => buildLeadStatsMatch(admin, { period: 'date', startDate: '', endDate: '' }),
    /required/,
  );
});

test('concurrent identical uncached requests share one producer', async () => {
  let calls = 0;
  const producer = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { totalLeads: 7 };
  };
  const [first, second] = await Promise.all([
    withSafeCache({ key: 'test:part2:dedupe' }, producer),
    withSafeCache({ key: 'test:part2:dedupe' }, producer),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(first.value, second.value);
});

test('local cache serves repeated metric reads and batched reference reads', async () => {
  const suffix = `${Date.now()}:${Math.random()}`;
  const metricKey = `test:part4:metric:${suffix}`;
  let calls = 0;
  await withSafeCache({ key: metricKey }, async () => {
    calls += 1;
    return { totalLeads: 9 };
  });
  const before = getCacheMetrics();
  const cached = await withSafeCache({ key: metricKey }, async () => {
    calls += 1;
    return { totalLeads: 0 };
  });
  const after = getCacheMetrics();
  assert.equal(calls, 1);
  assert.equal(cached.cacheStatus, 'hit');
  assert.ok(after.localHits > before.localHits);

  const keys = [`test:part4:a:${suffix}`, `test:part4:b:${suffix}`];
  await setCachedJsonMany([
    { key: keys[0], value: { id: 'a' } },
    { key: keys[1], value: { id: 'b' } },
  ]);
  assert.deepEqual(await getCachedJsonMany(keys), [{ id: 'a' }, { id: 'b' }]);
});
