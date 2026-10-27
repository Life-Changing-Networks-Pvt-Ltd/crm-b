import assert from 'node:assert/strict';
import test from 'node:test';

import { validateTaskStatusTransition } from '../../controllers/taskController.js';

const assignedTask = (status = 'Todo') => ({ status, assignedTo: 'employee-1' });

test('assigned employee follows the progress and review workflow', () => {
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('Todo'), nextStatus: 'In Progress', actorId: 'employee-1', canReview: false,
  }).valid, true);
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('In Progress'), nextStatus: 'In Review', actorId: 'employee-1', canReview: false,
  }).valid, true);
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('In Progress'), nextStatus: 'Done', actorId: 'employee-1', canReview: false,
  }).valid, false);
});

test('only a reviewer approves an in-review task', () => {
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('In Review'), nextStatus: 'Done', actorId: 'reviewer-1', canReview: true,
  }).valid, true);
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('Todo'), nextStatus: 'Done', actorId: 'reviewer-1', canReview: true,
  }).valid, false);
});

test('unassigned editors cannot update another employee progress', () => {
  assert.equal(validateTaskStatusTransition({
    task: assignedTask('Todo'), nextStatus: 'In Progress', actorId: 'employee-2', canReview: false,
  }).valid, false);
});
