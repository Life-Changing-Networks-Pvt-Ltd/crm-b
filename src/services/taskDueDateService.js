export const parseFutureTaskDueDate = (value, now = new Date()) => {
  if (value === undefined) return { valid: true, provided: false };
  if (value === null || value === '') {
    return { valid: true, provided: true, date: null };
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return { valid: false, message: 'Task due date is invalid' };
  }
  if (date.getTime() <= now.getTime()) {
    return { valid: false, message: 'Task due date must be in the future' };
  }
  return { valid: true, provided: true, date };
};
