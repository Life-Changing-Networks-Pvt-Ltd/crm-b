import test from 'node:test';
import assert from 'node:assert/strict';
import Company from '../../models/Company.js';
import FollowUp from '../../models/FollowUp.js';
import { configureRealtime } from '../realtimeService.js';
import { cancelLeadFollowUpReminders, filterExistingLeadReminders } from '../followUpReminderService.js';

const query = (value) => ({ select: () => ({ lean: async () => value }) });

test('deleted company cancels all active reminder types and removes their popups', async () => {
  const original = { find: FollowUp.find, updateMany: FollowUp.updateMany };
  const events = [];
  configureRealtime({ to: () => ({ emit: (...args) => events.push(args) }) }, new Map([['user', new Set(['socket'])]]));
  try {
    FollowUp.find = (filter) => {
      assert.deepEqual(filter, { lead: { $in: ['deleted'] }, status: { $in: ['Pending', 'Snoozed'] } });
      return query([{ _id: 'regular', assignedTo: ['user'] }, { _id: 'demo', assignedTo: ['user'] }]);
    };
    FollowUp.updateMany = async (filter, update) => {
      assert.deepEqual(filter._id.$in, ['regular', 'demo']);
      assert.deepEqual(filter.status.$in, ['Pending', 'Snoozed']);
      assert.deepEqual(update, { $set: { status: 'Cancelled' }, $unset: { activeKey: 1 } });
    };
    await cancelLeadFollowUpReminders(['deleted']);
    assert.deepEqual(events, [
      ['follow_up_cancelled', { _id: 'regular' }],
      ['follow_up_cancelled', { _id: 'demo' }],
    ]);
  } finally {
    Object.assign(FollowUp, original);
    configureRealtime(undefined, undefined);
  }
});

test('recovery keeps existing leads and cancels only orphaned reminders', async () => {
  const original = { companyFind: Company.find, find: FollowUp.find, updateMany: FollowUp.updateMany };
  try {
    Company.find = () => query([{ _id: 'existing' }]);
    FollowUp.find = (filter) => {
      assert.deepEqual(filter.lead.$in, ['missing']);
      return query([{ _id: 'orphan', assignedTo: [] }]);
    };
    FollowUp.updateMany = async (filter) => assert.deepEqual(filter._id.$in, ['orphan']);
    const good = { _id: 'good', lead: 'existing' };
    assert.deepEqual(await filterExistingLeadReminders([good, { _id: 'orphan', lead: 'missing' }]), [good]);
    assert.deepEqual(await filterExistingLeadReminders([]), []);
  } finally {
    Company.find = original.companyFind;
    FollowUp.find = original.find;
    FollowUp.updateMany = original.updateMany;
  }
});
