import { getPlatformMarketingSender } from '../modules/email-marketing/services/senderService.js';
import { sendSesEmail } from '../modules/email-marketing/services/sesService.js';
import {
  renderTaskAssignedEmail,
  renderTaskCompletedEmail,
} from './taskEmailTemplate.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (value = '') => String(value).trim().toLowerCase();
const slug = (value = '') => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 255) || 'unknown';

const taskUrl = () => {
  const origin = String(process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')[0]
    .trim()
    .replace(/\/+$/, '');
  return `${origin}/tasks`;
};

const deliver = async ({ recipient, rendered, purpose, task }) => {
  const normalizedRecipient = normalizeEmail(recipient);
  if (!emailPattern.test(normalizedRecipient)) {
    console.warn(`Task email skipped for ${task?._id || 'unknown task'}: invalid recipient`);
    return { status: 'skipped', reason: 'invalid_recipient' };
  }

  try {
    const sender = getPlatformMarketingSender({ requestedFromName: 'OPH Workplace' });
    const response = await sendSesEmail({
      fromName: sender.fromName,
      fromEmail: sender.fromEmail,
      replyTo: sender.replyTo,
      recipient: normalizedRecipient,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: {
        purpose,
        taskId: slug(task?._id),
      },
    });
    return { status: 'sent', providerMessageId: response.MessageId || '' };
  } catch (error) {
    const message = String(error?.message || 'Task email could not be sent').slice(0, 2000);
    console.error(`Task email ${purpose} failed for ${task?._id || 'unknown task'}:`, message);
    return { status: 'failed', error: message };
  }
};

export const sendTaskAssignedEmail = async ({ task }) => {
  const employee = task?.assignedTo;
  const rendered = renderTaskAssignedEmail({
    task,
    employee,
    taskUrl: taskUrl(),
  });
  return deliver({
    recipient: employee?.email,
    rendered,
    purpose: 'task-assigned',
    task,
  });
};

export const sendTaskCompletedAdminEmail = async ({ task, employee, completedAt }) => {
  const rendered = renderTaskCompletedEmail({
    task,
    employee,
    completedAt,
    taskUrl: taskUrl(),
  });
  return deliver({
    recipient: process.env.TASK_COMPLETION_ADMIN_EMAIL,
    rendered,
    purpose: 'task-completed',
    task,
  });
};
