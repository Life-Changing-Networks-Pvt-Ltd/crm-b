import assert from 'node:assert/strict';
import test from 'node:test';

import {
  renderTaskAssignedEmail,
  renderTaskCompletedEmail,
} from '../taskEmailTemplate.js';

const task = {
  _id: 'task-123',
  title: 'CRM Changes',
  description: 'Complete the requested CRM work.',
  priority: 'High',
  department: 'Development',
  dueDate: '2026-10-30T06:09:00.000Z',
  createdBy: { name: 'Admin User' },
};

test('task assignment email contains employee, task, deadline, and action link', () => {
  const rendered = renderTaskAssignedEmail({
    task,
    employee: { name: 'Abdul Kadir', email: 'abdul@example.com' },
    taskUrl: 'https://crm.example.com/tasks',
  });

  assert.equal(rendered.subject, 'New Task Assigned: CRM Changes');
  assert.match(rendered.text, /Hello Abdul Kadir/);
  assert.match(rendered.text, /Priority: High/);
  assert.match(rendered.text, /View Task: https:\/\/crm\.example\.com\/tasks/);
  assert.match(rendered.html, /Complete the requested CRM work\./);
});

test('task completion email asks admin to review and identifies the employee', () => {
  const rendered = renderTaskCompletedEmail({
    task,
    employee: { name: 'Abdul Kadir', email: 'abdul@example.com' },
    completedAt: '2026-10-27T06:30:00.000Z',
    taskUrl: 'https://crm.example.com/tasks',
  });

  assert.equal(rendered.subject, 'Task Submitted by Abdul Kadir: Review Required');
  assert.match(rendered.text, /Hello Admin/);
  assert.match(rendered.text, /Employee Email: abdul@example\.com/);
  assert.match(rendered.text, /ready for review/i);
  assert.match(rendered.html, /Review Completed Task/);
});

test('task email HTML escapes task and user supplied content', () => {
  const rendered = renderTaskAssignedEmail({
    task: { ...task, title: '<script>alert(1)</script>' },
    employee: { name: '<Admin>' },
    taskUrl: 'https://crm.example.com/tasks?a=1&b=2',
  });

  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /a=1&amp;b=2/);
});
