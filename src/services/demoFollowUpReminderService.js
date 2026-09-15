import FollowUp from '../models/FollowUp.js';
import { getFirstReminderAt } from '../utils/followUp.js';
import { cancelFollowUpReminder, scheduleFollowUpReminder } from './followUpReminderService.js';

const activeKeyFor = (lead) => `demo-follow-up:${lead._id}`;

export const cancelDemoFollowUpReminder = async (lead) => {
  const reminder = await FollowUp.findOneAndUpdate(
    { activeKey: activeKeyFor(lead) },
    { $set: { status: 'Cancelled' }, $unset: { activeKey: 1 } },
    { new: true },
  );
  if (reminder) await cancelFollowUpReminder(reminder._id);
};

// Uses the existing durable reminder runtime, including reconnect recovery,
// snooze, completion and repeat notifications to assigned employees.
export const syncDemoFollowUpReminder = async (lead, actorUserId) => {
  if (lead.leadStatus !== 'Demo follow-up') {
    await cancelDemoFollowUpReminder(lead);
    return;
  }
  const details = lead.statusDetails;
  if (!details?.demoFollowUpDateTime) return;
  const reminderBefore = details.reminder || '30_minutes';
  const assignedTo = lead.assignedTo?.length
    ? lead.assignedTo.map((user) => user._id || user)
    : [actorUserId];
  const reminder = await FollowUp.findOneAndUpdate(
    { activeKey: activeKeyFor(lead) },
    {
      $set: {
        lead: lead._id,
        companyName: lead.companyName,
        message: details.note || 'Demo follow-up',
        followUpDateTime: details.demoFollowUpDateTime,
        type: 'Demo',
        priority: 'Normal',
        reminderBefore,
        status: 'Pending',
        assignedTo,
        nextReminderAt: getFirstReminderAt(details.demoFollowUpDateTime, reminderBefore),
        lastRemindedAt: null,
        reminderCount: 0,
        snoozedUntil: null,
        completedAt: null,
        completedBy: null,
      },
      $setOnInsert: { createdBy: actorUserId },
      $inc: { version: 1 },
    },
    { new: true, upsert: true, runValidators: true },
  );
  await scheduleFollowUpReminder(reminder._id, reminder.nextReminderAt);
  return reminder;
};
