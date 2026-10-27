const escapeHtml = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const displayDate = (value) => {
  if (!value) return 'Not specified';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not specified';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
};

const taskDetailsRows = ({ task, completedBy = null, completedAt = null }) => {
  const rows = [
    ['Task', task.title],
    ['Description', task.description || 'No description provided'],
    ['Priority', task.priority || 'Medium'],
    ['Department', task.department || 'General'],
    ['Due Date', displayDate(task.dueDate)],
    ['Assigned By', task.createdBy?.name || 'Administrator'],
  ];
  if (completedBy) {
    rows.splice(2, 0,
      ['Completed By', completedBy.name || 'Assigned employee'],
      ['Employee Email', completedBy.email || 'Not available'],
      ['Completed On', displayDate(completedAt)],
    );
  }
  return rows;
};

const renderLayout = ({ eyebrow, title, intro, rows, actionLabel, taskUrl, footer }) => {
  const detailHtml = rows.map(([label, value]) => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;width:145px;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:14px;font-weight:600;white-space:pre-wrap;">${escapeHtml(value)}</td>
    </tr>`).join('');
  const actionHtml = taskUrl ? `
    <div style="margin:28px 0;text-align:center;">
      <a href="${escapeHtml(taskUrl)}" style="display:inline-block;background:#c97412;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px;">${escapeHtml(actionLabel)}</a>
    </div>` : '';

  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <div style="max-width:640px;margin:0 auto;padding:28px 14px;">
      <div style="background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 6px 24px rgba(15,23,42,.06);">
        <div style="background:#172033;padding:24px 28px;">
          <div style="color:#f59e0b;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:8px 0 0;color:#ffffff;font-size:24px;line-height:1.3;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:28px;">
          <p style="margin:0 0 20px;color:#334155;font-size:15px;line-height:1.7;">${escapeHtml(intro)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">${detailHtml}</table>
          ${actionHtml}
          <p style="margin:24px 0 0;color:#475569;font-size:14px;line-height:1.7;">${escapeHtml(footer)}</p>
        </div>
      </div>
      <p style="margin:16px 0 0;text-align:center;color:#94a3b8;font-size:12px;">OPH Workplace · Online Promotion House</p>
    </div>
  </body>
</html>`;
};

const renderText = ({ greeting, intro, rows, actionLabel, taskUrl, footer }) => [
  greeting,
  '',
  intro,
  '',
  'Task Details',
  ...rows.map(([label, value]) => `${label}: ${value}`),
  '',
  taskUrl ? `${actionLabel}: ${taskUrl}` : '',
  '',
  footer,
  '',
  'Regards,',
  'OPH Workplace Team',
  'Online Promotion House',
].filter((line, index, lines) => line || lines[index - 1] !== '').join('\n');

export const renderTaskAssignedEmail = ({ task, employee, taskUrl }) => {
  const rows = taskDetailsRows({ task });
  const employeeName = employee?.name || 'Team Member';
  const assignedBy = task.createdBy?.name || 'Administrator';
  const intro = `${assignedBy} has assigned a new task to you. Please review the requirements and complete it before the due date.`;
  const footer = 'Keep the task status updated and use the comments section to share progress or ask questions.';
  return {
    subject: `New Task Assigned: ${task.title}`,
    html: renderLayout({
      eyebrow: 'New Task Assignment',
      title: `Hello ${employeeName},`,
      intro,
      rows,
      actionLabel: 'View Task',
      taskUrl,
      footer,
    }),
    text: renderText({
      greeting: `Hello ${employeeName},`,
      intro,
      rows,
      actionLabel: 'View Task',
      taskUrl,
      footer,
    }),
  };
};

export const renderTaskCompletedEmail = ({ task, employee, completedAt, taskUrl }) => {
  const rows = taskDetailsRows({ task, completedBy: employee, completedAt });
  const employeeName = employee?.name || 'Assigned employee';
  const intro = `${employeeName} has submitted the following task as completed. The work is ready for review.`;
  const footer = 'Please approve the task or request changes after reviewing the submitted work.';
  return {
    subject: `Task Submitted by ${employeeName}: Review Required`,
    html: renderLayout({
      eyebrow: 'Task Completion Update',
      title: 'Task ready for review',
      intro,
      rows,
      actionLabel: 'Review Completed Task',
      taskUrl,
      footer,
    }),
    text: renderText({
      greeting: 'Hello Admin,',
      intro,
      rows,
      actionLabel: 'Review Completed Task',
      taskUrl,
      footer,
    }),
  };
};
