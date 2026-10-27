import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFutureTaskDueDate } from '../taskDueDateService.js';

const now = new Date('2026-10-27T09:00:00.000Z');

test('task due date accepts a future ISO date', () => {
  const result = parseFutureTaskDueDate('2026-10-27T09:01:00.000Z', now);
  assert.equal(result.valid, true);
  assert.equal(result.provided, true);
  assert.equal(result.date.toISOString(), '2026-10-27T09:01:00.000Z');
});

test('task due date rejects past, current, and invalid values', () => {
  assert.equal(parseFutureTaskDueDate('2026-10-27T08:59:00.000Z', now).valid, false);
  assert.equal(parseFutureTaskDueDate('2026-10-27T09:00:00.000Z', now).valid, false);
  assert.equal(parseFutureTaskDueDate('not-a-date', now).valid, false);
});

test('task due date distinguishes an omitted value from a cleared value', () => {
  assert.deepEqual(parseFutureTaskDueDate(undefined, now), {
    valid: true,
    provided: false,
  });
  assert.deepEqual(parseFutureTaskDueDate('', now), {
    valid: true,
    provided: true,
    date: null,
  });
});
