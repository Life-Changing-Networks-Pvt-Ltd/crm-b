import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadStatusDate } from '../../utils/leadStatusDate.js';
import { getFirstReminderAt, parseFollowUpPayload } from '../../utils/followUp.js';
import Lead from '../../models/Lead.js';
import Customer from '../../models/Customer.js';
import Company from '../../models/Company.js';
import FollowUp from '../../models/FollowUp.js';
import { parseStatusDetails } from '../../utils/statusDetails.js';

test('status date accepts an exact calendar date without timezone ambiguity', () => {
  assert.equal(
    parseLeadStatusDate('2026-07-27').toISOString(),
    '2026-07-27T00:00:00.000Z',
  );
});

test('status date preserves the exact selected time and timezone', () => {
  assert.equal(
    parseLeadStatusDate('2026-07-27T18:42:00.000+05:30').toISOString(),
    '2026-07-27T13:12:00.000Z',
  );
  assert.equal(
    parseLeadStatusDate('2026-07-27T13:12:00.000Z').toISOString(),
    '2026-07-27T13:12:00.000Z',
  );
});

test('missing status date preserves existing clients by using the current timestamp', () => {
  const now = new Date('2026-07-27T12:34:56.000Z');
  assert.equal(parseLeadStatusDate(undefined, () => now).toISOString(), now.toISOString());
});

test('invalid or impossible status dates are rejected', () => {
  assert.throws(() => parseLeadStatusDate('27-07-2026'), /ISO 8601/);
  assert.throws(() => parseLeadStatusDate('2026-02-30'), /invalid/);
  assert.throws(() => parseLeadStatusDate('2026-02-30T10:00:00.000Z'), /invalid/);
  assert.throws(() => parseLeadStatusDate(''), /ISO 8601/);
  assert.throws(() => parseLeadStatusDate('2026-07-27T18:42'), /ISO 8601/);
});

test('all unified lead models retain the latest effective status date without an extra read', () => {
  assert.ok(Lead.schema.path('leadStatusChangedAt'));
  assert.ok(Customer.schema.path('leadStatusChangedAt'));
  assert.ok(Company.schema.path('leadStatusChangedAt'));
});

test('company follow-up accepts a complete future schedule', () => {
  const parsed = parseFollowUpPayload({
    followUpRequired: true,
    followUpDateTime: '2026-07-29T12:00:00.000Z',
    followUpType: 'Call',
    followUpPriority: 'High',
    followUpReminder: '30_minutes',
  }, () => new Date('2026-07-28T12:00:00.000Z'));

  assert.equal(parsed.followUpRequired, true);
  assert.equal(parsed.followUpDateTime.toISOString(), '2026-07-29T12:00:00.000Z');
  assert.equal(parsed.followUpType, 'Call');
  assert.equal(parsed.followUpPriority, 'High');
  assert.equal(parsed.followUpReminder, '30_minutes');
});

test('disabling a follow-up clears stale schedule fields', () => {
  assert.deepEqual(parseFollowUpPayload({ followUpRequired: false }), {
    followUpRequired: false,
    followUpDateTime: null,
    followUpType: null,
    followUpPriority: null,
    followUpReminder: null,
  });
});

test('company follow-up rejects incomplete, invalid, and past schedules', () => {
  const now = () => new Date('2026-07-28T12:00:00.000Z');
  assert.throws(() => parseFollowUpPayload({ followUpRequired: 'yes' }, now), /Yes or No/);
  assert.throws(() => parseFollowUpPayload({ followUpRequired: true }, now), /required/);
  assert.throws(() => parseFollowUpPayload({
    followUpRequired: true,
    followUpDateTime: '2026-07-27T12:00:00.000Z',
    followUpType: 'Call',
    followUpPriority: 'Normal',
    followUpReminder: '1_hour',
  }, now), /future/);
  assert.throws(() => parseFollowUpPayload({
    followUpRequired: true,
    followUpDateTime: '2026-07-29T12:00:00.000Z',
    followUpType: 'SMS',
    followUpPriority: 'Normal',
    followUpReminder: '1_hour',
  }, now), /Type is invalid/);
});

test('company schema stores follow-up independently from status timestamps', () => {
  for (const field of [
    'followUpRequired',
    'followUpDateTime',
    'followUpType',
    'followUpPriority',
    'followUpReminder',
  ]) {
    assert.ok(Company.schema.path(field), `${field} must exist`);
  }
  assert.notEqual(Company.schema.path('followUpDateTime'), Company.schema.path('leadStatusChangedAt'));
  assert.ok(Company.schema.indexes().some(([fields]) => (
    fields.followUpRequired === 1 && fields.followUpDateTime === 1
  )));
});

test('follow-up reminder starts at the selected lead time', () => {
  assert.equal(
    getFirstReminderAt(
      '2026-07-29T12:00:00.000Z',
      '30_minutes',
      new Date('2026-07-28T12:00:00.000Z'),
    ).toISOString(),
    '2026-07-29T11:30:00.000Z',
  );
});

test('an already-open reminder window becomes due immediately', () => {
  assert.equal(
    getFirstReminderAt(
      '2026-07-28T12:20:00.000Z',
      '30_minutes',
      new Date('2026-07-28T12:00:00.000Z'),
    ).toISOString(),
    '2026-07-28T12:00:00.000Z',
  );
});

test('follow-up records retain a durable reminder lifecycle and one sparse active key', () => {
  for (const field of [
    'lead',
    'message',
    'followUpDateTime',
    'sourceStatus',
    'reminderBefore',
    'nextReminderAt',
    'lastRemindedAt',
    'reminderCount',
    'status',
  ]) {
    assert.ok(FollowUp.schema.path(field), `${field} must exist`);
  }
  const activeIndex = FollowUp.schema.indexes().find(([fields]) => fields.activeKey === 1);
  assert.equal(activeIndex?.[1]?.unique, true);
  assert.equal(activeIndex?.[1]?.sparse, true);
});

test('status details validate demo and closure requirements', () => {
  const demo = parseStatusDetails('Demo Scheduled', {
    demoDateTime: '2026-08-01T10:00:00.000Z',
    demoMode: 'Online',
    meetingLink: 'https://meet.example.com/demo',
    reminder: '30_minutes',
  });
  assert.equal(demo.demoMode, 'Online');
  assert.equal(demo.demoDateTime.toISOString(), '2026-08-01T10:00:00.000Z');
  assert.throws(() => parseStatusDetails('Demo Scheduled', {}), /Date & Time is required/);
  assert.throws(() => parseStatusDetails('Not Interested', {}), /reason is required/);
});

test('unified status comments can be saved before activity reminder scheduling', () => {
  const demoFollowUp = parseStatusDetails(
    'Demo follow-up',
    { note: 'Call after the demo' },
    new Date(),
    { requireSchedule: false },
  );
  const demoScheduled = parseStatusDetails(
    'Demo Scheduled',
    { note: 'Demo requested', demoMode: 'Online' },
    new Date(),
    { requireSchedule: false },
  );

  assert.equal(demoFollowUp.demoFollowUpDateTime, null);
  assert.equal(demoFollowUp.note, 'Call after the demo');
  assert.equal(demoScheduled.demoDateTime, null);
  assert.equal(demoScheduled.note, 'Demo requested');
});

test('company schema stores additive status-specific details', () => {
  for (const field of [
    'statusDetails.status',
    'statusDetails.note',
    'statusDetails.demoDateTime',
    'statusDetails.reason',
    'statusDetails.estimatedDealValue',
    'statusDetails.finalDealValue',
  ]) {
    assert.ok(Company.schema.path(field), `${field} must exist`);
  }
});
