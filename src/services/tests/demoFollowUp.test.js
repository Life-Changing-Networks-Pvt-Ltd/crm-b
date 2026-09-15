import test from 'node:test';
import assert from 'node:assert/strict';
import Company from '../../models/Company.js';
import Customer from '../../models/Customer.js';
import Lead from '../../models/Lead.js';
import LeadStatusHistory from '../../models/LeadStatusHistory.js';
import { parseStatusDetails } from '../../utils/statusDetails.js';
import { buildCompanyStatusPeriodFilter, calculateLeadStatsLegacy, calculateLeadStatsAggregated } from '../leadStatsService.js';
import { buildDashboardMetricMatch, buildDemoFollowUpDashboardMatch, calculateDashboardMetricsLegacy } from '../dashboardMetricsService.js';

const admin = { role: 'admin' };
const filters = { period: 'date', startDate: '2026-09-20', endDate: '2026-09-20', type: 'Company' };

test('demo follow-up requires a real date and timezone, and preserves AM/PM instants', async () => {
  assert.equal(parseStatusDetails('New', { demoFollowUpDateTime: '2026-09-20T15:30', note: 'Change status' }).demoFollowUpDateTime, null);
  assert.throws(() => parseStatusDetails('Demo follow-up', { note: 'Call later' }), /required/);
  for (const invalid of ['2026-09-20', '2026-09-20T15:30', '2026-02-30T15:30:00+05:30']) {
    assert.throws(() => parseStatusDetails('Demo follow-up', { demoFollowUpDateTime: invalid }));
  }
  for (const [hour, expected] of [['00', '2026-09-19T18:30:00.000Z'], ['12', '2026-09-20T06:30:00.000Z'], ['15', '2026-09-20T09:30:00.000Z']]) {
    const details = parseStatusDetails('Demo follow-up', { demoFollowUpDateTime: `2026-09-20T${hour}:00:00+05:30`, note: ' Call after demo ' });
    assert.equal(details.demoFollowUpDateTime.toISOString(), expected);
    assert.equal(details.note, 'Call after demo');
    assert.equal(details.demoDateTime, null);
    for (const Model of [Company, Customer, Lead]) {
      const lead = new Model({ statusDetails: details });
      await lead.validate(['statusDetails']);
      assert.equal(lead.statusDetails.demoFollowUpDateTime.toISOString(), expected);
    }
  }
});

test('dashboard schedules Demo follow-up by appointment date while retaining creation dates for other statuses', () => {
  const original = buildDashboardMetricMatch(admin, filters, { assignedTo: 'employee' });
  const match = buildDemoFollowUpDashboardMatch(original);
  assert.equal(match.assignedTo, 'employee');
  assert.equal(match.createdAt, undefined);
  assert.equal(original.createdAt.$gte.toISOString(), '2026-09-19T18:30:00.000Z');
  assert.deepEqual(match.$or[0], { leadStatus: { $ne: 'Demo follow-up' }, createdAt: original.createdAt });
  assert.deepEqual(match.$or[1], { leadStatus: 'Demo follow-up', 'statusDetails.demoFollowUpDateTime': original.createdAt });
  assert.deepEqual(buildDemoFollowUpDashboardMatch({ assignedTo: 'employee' }), { assignedTo: 'employee' });
});

test('Leads list, aggregate counts, and legacy counts use the same appointment date', async () => {
  const listFilter = buildCompanyStatusPeriodFilter('Demo follow-up', filters);
  assert.match(JSON.stringify(listFilter), /\$statusDetails.demoFollowUpDateTime/);
  assert.doesNotMatch(JSON.stringify(listFilter), /createdAt|leadStatusChangedAt|scheduledDateTime/);
  assert.deepEqual(buildCompanyStatusPeriodFilter('Demo follow-up', { period: 'all' }), {});
  const originalCount = Company.countDocuments;
  const originalAggregate = Company.aggregate;
  const originalCustomerCount = Customer.countDocuments;
  const originalHistoryAggregate = LeadStatusHistory.aggregate;
  try {
    Company.countDocuments = async (query) => {
      if (query.leadStatus === 'Demo follow-up') {
        assert.deepEqual(query.$expr, listFilter.$expr);
        return 2;
      }
      return 0;
    };
    assert.equal((await calculateLeadStatsLegacy(admin, filters)).demoFollowUp, 2);
    // Check the actual aggregation expression without contacting a database.
    Company.aggregate = async (pipeline) => {
      const condition = pipeline[1].$group.demoFollowUp.$sum.$cond[0];
      assert.deepEqual(condition.$and[1], listFilter.$expr);
      return [{ demoFollowUp: 2 }];
    };
    LeadStatusHistory.aggregate = async () => [];
    assert.equal((await calculateLeadStatsAggregated(admin, filters)).demoFollowUp, 2);
    Company.countDocuments = async (query) => {
      if (query.leadStatus === 'Demo follow-up') {
        assert.equal(query.createdAt, undefined);
        assert.equal(query['statusDetails.demoFollowUpDateTime'].$gte.toISOString(), '2026-09-19T18:30:00.000Z');
        return 2;
      }
      return 0;
    };
    Customer.countDocuments = async () => 0;
    assert.equal((await calculateDashboardMetricsLegacy(admin, filters)).demoFollowUp, 2);
  } finally {
    Company.countDocuments = originalCount;
    Company.aggregate = originalAggregate;
    Customer.countDocuments = originalCustomerCount;
    LeadStatusHistory.aggregate = originalHistoryAggregate;
  }
});
