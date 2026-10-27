export const DATA_SCOPES = Object.freeze(['none', 'own', 'team', 'hierarchy', 'all']);

export const PERMISSIONS = Object.freeze({
  DASHBOARD_VIEW: 'dashboard.view',

  LEADS_VIEW: 'leads.view',
  LEADS_CREATE: 'leads.create',
  LEADS_EDIT: 'leads.edit',
  LEADS_DELETE: 'leads.delete',
  LEADS_CHANGE_STATUS: 'leads.change_status',
  LEADS_ASSIGN: 'leads.assign',
  LEADS_ADD_NOTE: 'leads.add_note',
  LEADS_MANAGE_NOTIFICATIONS: 'leads.manage_notifications',

  EMPLOYEES_VIEW: 'employees.view',
  EMPLOYEES_MANAGE: 'employees.manage',
  ATTENDANCE_VIEW: 'attendance.view',
  ATTENDANCE_MANAGE: 'attendance.manage',
  CALLS_VIEW: 'calls.view',
  CALLS_MANAGE: 'calls.manage',
  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  TASKS_VIEW: 'tasks.view',
  TASKS_CREATE: 'tasks.create',
  TASKS_EDIT: 'tasks.edit',
  TASKS_REVIEW: 'tasks.review',
  TASKS_DELETE: 'tasks.delete',
  TASKS_ASSIGN: 'tasks.assign',

  EMAIL_MODULE_VIEW: 'email.module.view',
  EMAIL_TEMPLATES_CREATE: 'email.templates.create',
  EMAIL_TEMPLATES_EDIT: 'email.templates.edit',
  EMAIL_TEMPLATES_SHARE: 'email.templates.share',
  EMAIL_TEMPLATES_USE: 'email.templates.use',
  EMAIL_SEND_LEAD: 'email.send.lead',
  EMAIL_CAMPAIGNS_MANAGE: 'email.campaigns.manage',

  WHATSAPP_MODULE_VIEW: 'whatsapp.module.view',
  WHATSAPP_TEMPLATES_CREATE: 'whatsapp.templates.create',
  WHATSAPP_TEMPLATES_EDIT: 'whatsapp.templates.edit',
  WHATSAPP_TEMPLATES_SHARE: 'whatsapp.templates.share',
  WHATSAPP_TEMPLATES_USE: 'whatsapp.templates.use',
  WHATSAPP_SEND_LEAD: 'whatsapp.send.lead',
  WHATSAPP_CAMPAIGNS_MANAGE: 'whatsapp.campaigns.manage',

  ADMIN_USERS_VIEW: 'admin.users.view',
  ADMIN_USERS_MANAGE: 'admin.users.manage',
  ADMIN_ROLES_VIEW: 'admin.roles.view',
  ADMIN_ROLES_MANAGE: 'admin.roles.manage',
  ADMIN_TEAMS_VIEW: 'admin.teams.view',
  ADMIN_TEAMS_MANAGE: 'admin.teams.manage',
  ADMIN_TEMPLATE_ACCESS_VIEW: 'admin.template_access.view',
  ADMIN_TEMPLATE_ACCESS_MANAGE: 'admin.template_access.manage',
  ADMIN_SETTINGS_MANAGE: 'admin.settings.manage',
  ADMIN_AUDIT_VIEW: 'admin.audit.view',
});

export const PERMISSION_VALUES = Object.freeze(Object.values(PERMISSIONS));

// Action permissions include the minimum page permission required to use them.
// Explicit per-user denies are applied after these implications are expanded.
export const IMPLIED_PERMISSIONS = Object.freeze({
  [PERMISSIONS.LEADS_CREATE]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_EDIT]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_DELETE]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_CHANGE_STATUS]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_ASSIGN]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_ADD_NOTE]: [PERMISSIONS.LEADS_VIEW],
  [PERMISSIONS.LEADS_MANAGE_NOTIFICATIONS]: [PERMISSIONS.LEADS_VIEW, PERMISSIONS.EMPLOYEES_VIEW],
  [PERMISSIONS.EMPLOYEES_MANAGE]: [PERMISSIONS.EMPLOYEES_VIEW],
  [PERMISSIONS.ATTENDANCE_MANAGE]: [PERMISSIONS.ATTENDANCE_VIEW],
  [PERMISSIONS.CALLS_MANAGE]: [PERMISSIONS.CALLS_VIEW],
  [PERMISSIONS.REPORTS_EXPORT]: [PERMISSIONS.REPORTS_VIEW],
  [PERMISSIONS.TASKS_CREATE]: [PERMISSIONS.TASKS_VIEW],
  [PERMISSIONS.TASKS_EDIT]: [PERMISSIONS.TASKS_VIEW],
  [PERMISSIONS.TASKS_REVIEW]: [PERMISSIONS.TASKS_VIEW],
  [PERMISSIONS.TASKS_DELETE]: [PERMISSIONS.TASKS_VIEW],
  [PERMISSIONS.TASKS_ASSIGN]: [PERMISSIONS.TASKS_VIEW],
  [PERMISSIONS.EMAIL_TEMPLATES_CREATE]: [PERMISSIONS.EMAIL_MODULE_VIEW],
  [PERMISSIONS.EMAIL_TEMPLATES_EDIT]: [PERMISSIONS.EMAIL_MODULE_VIEW],
  [PERMISSIONS.EMAIL_TEMPLATES_SHARE]: [PERMISSIONS.EMAIL_MODULE_VIEW],
  [PERMISSIONS.EMAIL_CAMPAIGNS_MANAGE]: [PERMISSIONS.EMAIL_MODULE_VIEW],
  [PERMISSIONS.WHATSAPP_TEMPLATES_CREATE]: [PERMISSIONS.WHATSAPP_MODULE_VIEW],
  [PERMISSIONS.WHATSAPP_TEMPLATES_EDIT]: [PERMISSIONS.WHATSAPP_MODULE_VIEW],
  [PERMISSIONS.WHATSAPP_TEMPLATES_SHARE]: [PERMISSIONS.WHATSAPP_MODULE_VIEW],
  [PERMISSIONS.WHATSAPP_CAMPAIGNS_MANAGE]: [PERMISSIONS.WHATSAPP_MODULE_VIEW],
  [PERMISSIONS.ADMIN_USERS_MANAGE]: [PERMISSIONS.ADMIN_USERS_VIEW],
  [PERMISSIONS.ADMIN_ROLES_MANAGE]: [PERMISSIONS.ADMIN_ROLES_VIEW],
  [PERMISSIONS.ADMIN_TEAMS_MANAGE]: [PERMISSIONS.ADMIN_TEAMS_VIEW],
  [PERMISSIONS.ADMIN_TEMPLATE_ACCESS_MANAGE]: [PERMISSIONS.ADMIN_TEMPLATE_ACCESS_VIEW],
});

export const expandImpliedPermissions = (permissions = []) => {
  const expanded = new Set(normalizePermissionList(permissions));
  const pending = [...expanded];
  while (pending.length) {
    const permission = pending.pop();
    for (const implied of IMPLIED_PERMISSIONS[permission] || []) {
      if (!expanded.has(implied)) {
        expanded.add(implied);
        pending.push(implied);
      }
    }
  }
  return [...expanded];
};

export const PERMISSION_GROUPS = Object.freeze([
  {
    id: 'dashboard',
    label: 'Dashboard',
    permissions: [
      { key: PERMISSIONS.DASHBOARD_VIEW, label: 'View dashboard' },
    ],
  },
  {
    id: 'leads',
    label: 'Leads',
    supportsScope: true,
    permissions: [
      { key: PERMISSIONS.LEADS_VIEW, label: 'View leads' },
      { key: PERMISSIONS.LEADS_CREATE, label: 'Create leads' },
      { key: PERMISSIONS.LEADS_EDIT, label: 'Edit leads' },
      { key: PERMISSIONS.LEADS_DELETE, label: 'Delete leads' },
      { key: PERMISSIONS.LEADS_CHANGE_STATUS, label: 'Change lead status' },
      { key: PERMISSIONS.LEADS_ASSIGN, label: 'Assign leads' },
      { key: PERMISSIONS.LEADS_ADD_NOTE, label: 'Add notes' },
      { key: PERMISSIONS.LEADS_MANAGE_NOTIFICATIONS, label: 'Manage lead notifications' },
    ],
  },
  {
    id: 'employees',
    label: 'Employees',
    supportsScope: true,
    permissions: [
      { key: PERMISSIONS.EMPLOYEES_VIEW, label: 'View employees' },
      { key: PERMISSIONS.EMPLOYEES_MANAGE, label: 'Manage employees' },
    ],
  },
  {
    id: 'attendance',
    label: 'Attendance',
    supportsScope: true,
    permissions: [
      { key: PERMISSIONS.ATTENDANCE_VIEW, label: 'View attendance' },
      { key: PERMISSIONS.ATTENDANCE_MANAGE, label: 'Manage attendance' },
    ],
  },
  {
    id: 'tasks',
    label: 'Tasks & Projects',
    supportsScope: true,
    permissions: [
      { key: PERMISSIONS.TASKS_VIEW, label: 'View tasks' },
      { key: PERMISSIONS.TASKS_CREATE, label: 'Create tasks' },
      { key: PERMISSIONS.TASKS_EDIT, label: 'Edit & update task status' },
      { key: PERMISSIONS.TASKS_REVIEW, label: 'Review & approve tasks' },
      { key: PERMISSIONS.TASKS_ASSIGN, label: 'Assign tasks to others' },
      { key: PERMISSIONS.TASKS_DELETE, label: 'Archive tasks' },
    ],
  },
  {
    id: 'calling',
    label: 'Calling',
    permissions: [
      { key: PERMISSIONS.CALLS_VIEW, label: 'View calls' },
      { key: PERMISSIONS.CALLS_MANAGE, label: 'Manage calls' },
    ],
  },
  {
    id: 'reports',
    label: 'Reports',
    supportsScope: true,
    permissions: [
      { key: PERMISSIONS.REPORTS_VIEW, label: 'View reports' },
      { key: PERMISSIONS.REPORTS_EXPORT, label: 'Export reports' },
    ],
  },
  {
    id: 'email',
    label: 'Email Marketing',
    permissions: [
      { key: PERMISSIONS.EMAIL_MODULE_VIEW, label: 'Open Email Marketing' },
      { key: PERMISSIONS.EMAIL_TEMPLATES_CREATE, label: 'Create templates' },
      { key: PERMISSIONS.EMAIL_TEMPLATES_EDIT, label: 'Edit templates' },
      { key: PERMISSIONS.EMAIL_TEMPLATES_SHARE, label: 'Share templates' },
      { key: PERMISSIONS.EMAIL_TEMPLATES_USE, label: 'Use shared templates' },
      { key: PERMISSIONS.EMAIL_SEND_LEAD, label: 'Send email to leads' },
      { key: PERMISSIONS.EMAIL_CAMPAIGNS_MANAGE, label: 'Manage campaigns' },
    ],
  },
  {
    id: 'whatsapp',
    label: 'WhatsApp Marketing',
    permissions: [
      { key: PERMISSIONS.WHATSAPP_MODULE_VIEW, label: 'Open WhatsApp Marketing' },
      { key: PERMISSIONS.WHATSAPP_TEMPLATES_CREATE, label: 'Create templates' },
      { key: PERMISSIONS.WHATSAPP_TEMPLATES_EDIT, label: 'Edit templates' },
      { key: PERMISSIONS.WHATSAPP_TEMPLATES_SHARE, label: 'Share templates' },
      { key: PERMISSIONS.WHATSAPP_TEMPLATES_USE, label: 'Use shared templates' },
      { key: PERMISSIONS.WHATSAPP_SEND_LEAD, label: 'Send WhatsApp to leads' },
      { key: PERMISSIONS.WHATSAPP_CAMPAIGNS_MANAGE, label: 'Manage campaigns' },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    permissions: [
      { key: PERMISSIONS.ADMIN_USERS_VIEW, label: 'View users' },
      { key: PERMISSIONS.ADMIN_USERS_MANAGE, label: 'Manage users' },
      { key: PERMISSIONS.ADMIN_ROLES_VIEW, label: 'View roles' },
      { key: PERMISSIONS.ADMIN_ROLES_MANAGE, label: 'Manage roles' },
      { key: PERMISSIONS.ADMIN_TEAMS_VIEW, label: 'View teams' },
      { key: PERMISSIONS.ADMIN_TEAMS_MANAGE, label: 'Manage teams' },
      { key: PERMISSIONS.ADMIN_TEMPLATE_ACCESS_VIEW, label: 'View template access' },
      { key: PERMISSIONS.ADMIN_TEMPLATE_ACCESS_MANAGE, label: 'Manage template access' },
      { key: PERMISSIONS.ADMIN_SETTINGS_MANAGE, label: 'Manage settings' },
      { key: PERMISSIONS.ADMIN_AUDIT_VIEW, label: 'View audit logs' },
    ],
  },
]);

const page = (...grants) => grants;

export const LEGACY_PAGE_PERMISSION_MAP = Object.freeze({
  '/': page(PERMISSIONS.DASHBOARD_VIEW),
  '/dashboard': page(PERMISSIONS.DASHBOARD_VIEW),
  '/leads': page(
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.LEADS_CREATE,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.LEADS_CHANGE_STATUS,
    PERMISSIONS.LEADS_ASSIGN,
    PERMISSIONS.LEADS_ADD_NOTE,
  ),
  '/companies': page(
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.LEADS_CREATE,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.LEADS_CHANGE_STATUS,
    PERMISSIONS.LEADS_ASSIGN,
    PERMISSIONS.LEADS_ADD_NOTE,
  ),
  '/employees': page(PERMISSIONS.EMPLOYEES_VIEW),
  '/attendance': page(PERMISSIONS.ATTENDANCE_VIEW),
  '/tasks': page(
    PERMISSIONS.TASKS_VIEW,
    PERMISSIONS.TASKS_CREATE,
    PERMISSIONS.TASKS_EDIT,
    PERMISSIONS.TASKS_REVIEW,
    PERMISSIONS.TASKS_ASSIGN,
  ),
  '/calls': page(PERMISSIONS.CALLS_VIEW),
  '/calling': page(PERMISSIONS.CALLS_VIEW, PERMISSIONS.CALLS_MANAGE),
  '/reports': page(PERMISSIONS.REPORTS_VIEW),
  '/reports/users': page(PERMISSIONS.REPORTS_VIEW),
  '/reports/attendance': page(PERMISSIONS.ATTENDANCE_VIEW),
  '/email-marketing': page(
    PERMISSIONS.EMAIL_MODULE_VIEW,
    PERMISSIONS.EMAIL_TEMPLATES_USE,
    PERMISSIONS.EMAIL_SEND_LEAD,
  ),
  '/whatsapp-marketing': page(
    PERMISSIONS.WHATSAPP_MODULE_VIEW,
    PERMISSIONS.WHATSAPP_TEMPLATES_USE,
    PERMISSIONS.WHATSAPP_SEND_LEAD,
  ),
  '/users': page(PERMISSIONS.ADMIN_USERS_VIEW, PERMISSIONS.ADMIN_USERS_MANAGE),
  '/roles': page(PERMISSIONS.ADMIN_ROLES_VIEW, PERMISSIONS.ADMIN_ROLES_MANAGE),
  '/page-access': page(
    PERMISSIONS.ADMIN_ROLES_VIEW,
    PERMISSIONS.ADMIN_ROLES_MANAGE,
  ),
  '/teams': page(PERMISSIONS.ADMIN_TEAMS_VIEW, PERMISSIONS.ADMIN_TEAMS_MANAGE),
  '/settings': page(PERMISSIONS.ADMIN_SETTINGS_MANAGE),
});

export const normalizePermissionList = (values = []) => Array.from(
  new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  ),
);

export const legacyPermissionsToGrants = (permissions = []) => normalizePermissionList(
  normalizePermissionList(permissions).flatMap((permission) => (
    LEGACY_PAGE_PERMISSION_MAP[permission] || (
      PERMISSION_VALUES.includes(permission) ? [permission] : []
    )
  )),
);

export const sanitizeDataScopes = (scopes = {}) => Object.fromEntries(
  Object.entries(scopes || {})
    .filter(([, value]) => DATA_SCOPES.includes(value))
    .map(([key, value]) => [String(key), value]),
);
