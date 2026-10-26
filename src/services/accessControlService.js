import Role from '../models/Role.js';
import Team from '../models/Team.js';
import User from '../models/User.js';
import {
  legacyPermissionsToGrants,
  normalizePermissionList,
  sanitizeDataScopes,
  expandImpliedPermissions,
  IMPLIED_PERMISSIONS,
} from '../constants/permissions.js';
import { isAdminUser } from '../utils/hierarchy.js';
import {
  cacheKeys,
  getAccessCacheVersion,
  getCachedJson,
  getCachedJsonMany,
  setCachedJson,
  setCachedJsonMany,
} from './cacheService.js';

const DEFAULT_SCOPES = Object.freeze({
  leads: 'own',
  employees: 'own',
  attendance: 'own',
  calls: 'own',
  reports: 'own',
});

const getRoleForUser = async (user) => {
  if (user?.roleRef) {
    const role = await Role.findById(user.roleRef).lean();
    if (role) return role;
  }
  if (!user?.role) return null;
  return Role.findOne({ name: user.role }).lean();
};

export const resolveAccountOwnerId = async (user) => {
  let current = user;
  const visited = new Set();

  for (let depth = 0; depth < 50 && current?._id; depth += 1) {
    const currentId = String(current._id);
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const parentId = current.parent || current.createdBy;
    if (!parentId || String(parentId) === currentId) return current._id;

    const parent = await User.findById(parentId)
      .select('_id parent createdBy')
      .lean();
    if (!parent) return current._id;
    current = parent;
  }

  return user._id;
};

// Account membership follows the same rule as resolveAccountOwnerId:
// parent takes precedence, and createdBy links root-level users to an owner.
export const getAccountUserIds = async (ownerId) => {
  const allowedIds = new Set([String(ownerId)]);
  let frontier = [ownerId];

  for (let depth = 0; depth < 50 && frontier.length; depth += 1) {
    const users = await User.find({
      isActive: true,
      $or: [
        { parent: { $in: frontier } },
        {
          $and: [
            { parent: null },
            { createdBy: { $in: frontier } },
          ],
        },
      ],
    }).select('_id').lean();
    const next = users
      .map((user) => String(user._id))
      .filter((userId) => !allowedIds.has(userId));
    next.forEach((userId) => allowedIds.add(userId));
    frontier = next;
  }

  return Array.from(allowedIds);
};

const calculateEffectiveAccessWithRole = (user, role = null) => {
  if (!user) {
    return {
      isAdmin: false,
      permissions: [],
      grants: [],
      scopes: { ...DEFAULT_SCOPES },
      teamIds: [],
      roleId: null,
      accessVersion: 1,
    };
  }

  if (isAdminUser(user)) {
    return {
      isAdmin: true,
      permissions: [],
      grants: ['*'],
      scopes: Object.fromEntries(
        Object.keys(DEFAULT_SCOPES).map((key) => [key, 'all']),
      ),
      teamIds: (user.teams || []).map(String),
      roleId: user.roleRef ? String(user.roleRef) : null,
      accessVersion: 2,
    };
  }

  if (String(user?.role || '').toLowerCase() === 'vendor') {
    return {
      isAdmin: false,
      isVendor: true,
      permissions: [],
      grants: [
        'dashboard.view',
        'leads.view',
        'leads.create',
        'leads.edit',
        'leads.assign',
        'leads.change_status',
        'leads.add_note',
        'employees.view',
        'employees.manage',
        'admin.settings.manage',
      ],
      scopes: {
        leads: 'hierarchy',
        employees: 'hierarchy',
      },
      teamIds: (user.teams || []).map(String),
      roleId: null,
      accessVersion: 2,
    };
  }

  const legacyPermissions = normalizePermissionList(role?.permissions);
  const accessVersion = Number(role?.permissionVersion || 1);
  const baseGrants = normalizePermissionList([
    ...(role?.grants || []),
    ...(accessVersion < 2 ? legacyPermissionsToGrants(legacyPermissions) : []),
  ]);
  const allowed = normalizePermissionList(user.permissionOverrides?.allow);
  const denied = new Set(normalizePermissionList(user.permissionOverrides?.deny));
  const grants = expandImpliedPermissions([...baseGrants, ...allowed])
    .filter((permission) => (
      !denied.has(permission)
      && !(IMPLIED_PERMISSIONS[permission] || []).some((required) => denied.has(required))
    ));

  const scopes = {
    ...DEFAULT_SCOPES,
    ...sanitizeDataScopes(role?.dataScopes),
    ...sanitizeDataScopes(user.scopeOverrides),
  };

  return {
    isAdmin: false,
    permissions: legacyPermissions,
    grants,
    scopes,
    teamIds: (user.teams || []).map(String),
    roleId: role?._id ? String(role._id) : null,
    accessVersion,
  };
};

const calculateEffectiveAccess = async (user) => (
  calculateEffectiveAccessWithRole(user, await getRoleForUser(user))
);

export const resolveEffectiveAccess = async (user) => {
  if (!user?._id) return calculateEffectiveAccess(user);
  const version = await getAccessCacheVersion();
  const key = cacheKeys.access(version, String(user._id));
  const cached = await getCachedJson(key);
  if (cached) return cached;
  const access = await calculateEffectiveAccess(user);
  await setCachedJson(key, access, 120);
  return access;
};

// Resolve access for a collection without issuing one Role query per user.
export const resolveEffectiveAccessMany = async (users = []) => {
  if (!users.length) return [];

  const version = await getAccessCacheVersion();
  const keys = users.map((user) => (
    user?._id ? cacheKeys.access(version, String(user._id)) : null
  ));
  const cachedValues = await getCachedJsonMany(keys.filter(Boolean));
  let cachedIndex = 0;
  const cacheEntries = keys.map((key) => ({
    key,
    value: key ? cachedValues[cachedIndex++] : null,
  }));

  const missingIndexes = cacheEntries
    .map((entry, index) => (entry.value ? -1 : index))
    .filter((index) => index >= 0);
  if (!missingIndexes.length) return cacheEntries.map((entry) => entry.value);

  const roleIds = [];
  const roleNames = [];
  missingIndexes.forEach((index) => {
    const user = users[index];
    if (!user || isAdminUser(user)) return;
    if (user.roleRef) roleIds.push(user.roleRef);
    if (user.role) roleNames.push(user.role);
  });

  const roleFilter = [];
  if (roleIds.length) roleFilter.push({ _id: { $in: roleIds } });
  if (roleNames.length) roleFilter.push({ name: { $in: roleNames } });
  const roles = roleFilter.length
    ? await Role.find({ $or: roleFilter }).lean()
    : [];
  const rolesById = new Map(roles.map((role) => [String(role._id), role]));
  const rolesByName = new Map(roles.map((role) => [role.name, role]));

  const cacheWrites = [];
  missingIndexes.forEach((index) => {
    const user = users[index];
    const role = user?.roleRef
      ? rolesById.get(String(user.roleRef)) || rolesByName.get(user.role)
      : rolesByName.get(user?.role);
    const access = calculateEffectiveAccessWithRole(user, role);
    cacheEntries[index].value = access;
    if (cacheEntries[index].key) {
      cacheWrites.push({ key: cacheEntries[index].key, value: access });
    }
  });
  await setCachedJsonMany(cacheWrites, 120);

  return cacheEntries.map((entry) => entry.value);
};

export const userHasPermission = (access, requiredPermission) => {
  if (!requiredPermission) return true;
  const grants = new Set(access?.grants || []);
  if (grants.has('*') || grants.has(requiredPermission)) return true;

  const [namespace] = requiredPermission.split('.');
  return grants.has(`${namespace}.*`);
};

export const getUserTeamMemberIds = async (user) => {
  const teamIds = (user?.teams || []).filter(Boolean);
  if (!teamIds.length) return [user._id];

  const teams = await Team.find({
    _id: { $in: teamIds },
    status: 'active',
  }).select('members manager').lean();

  return Array.from(new Set([
    String(user._id),
    ...teams.flatMap((team) => [
      team.manager ? String(team.manager) : null,
      ...(team.members || []).map(String),
    ]).filter(Boolean),
  ]));
};
