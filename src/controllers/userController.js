import User from '../models/User.js';
import Role from '../models/Role.js';
import Employee from '../models/Employee.js';
import { successResponse, errorResponse } from '../utils/response.js';
import { logActivity } from '../utils/activity.js';
import { escapeRegex, pagedData, paginationMeta, parsePagination, safeSort } from '../services/listQueryService.js';
import { reconcileUserEmployee } from '../services/employeeUserReconciliationService.js';
import Team from '../models/Team.js';
import {
  PERMISSIONS,
  PERMISSION_VALUES,
  normalizePermissionList,
  sanitizeDataScopes,
} from '../constants/permissions.js';
import { resolveUserDataScope } from '../services/dataScopeService.js';
import {
  getAccountUserIds,
  resolveAccountOwnerId,
  resolveEffectiveAccessMany,
  userHasPermission,
} from '../services/accessControlService.js';
import { isAdminUser } from '../utils/hierarchy.js';
import {
  cacheKeys,
  getReferenceCacheVersion,
  invalidateAccessCaches,
  invalidateAuthenticatedUserCache,
  invalidateUserReferenceCaches,
  withJsonCache,
} from '../services/cacheService.js';

const sanitizeOverrides = (overrides = {}) => ({
  allow: normalizePermissionList(overrides.allow)
    .filter((permission) => PERMISSION_VALUES.includes(permission)),
  deny: normalizePermissionList(overrides.deny)
    .filter((permission) => PERMISSION_VALUES.includes(permission)),
});

const resolveRoleInput = async ({ role, roleId }) => {
  const roleDoc = roleId
    ? await Role.findById(roleId)
    : role ? await Role.findOne({ name: role }) : null;

  if ((roleId || role) && !roleDoc) {
    const error = new Error('Selected role does not exist');
    error.statusCode = 400;
    throw error;
  }
  return roleDoc;
};

const syncUserTeams = async (userId, teamIds = []) => {
  const normalizedTeamIds = Array.from(new Set(
    (Array.isArray(teamIds) ? teamIds : []).map(String),
  ));
  await Team.updateMany({ members: userId }, { $pull: { members: userId } });
  if (normalizedTeamIds.length) {
    await Team.updateMany(
      { _id: { $in: normalizedTeamIds } },
      { $addToSet: { members: userId } },
    );
  }
  return normalizedTeamIds;
};

// @desc    Get all users
// @route   GET /api/users
// @access  Private
export const getUsers = async (req, res, next) => {
  try {
    const { role, startDate, endDate } = req.query;
    
    let filter = {};
    
    if (role && role !== 'all') {
      filter.role = role;
    }
    
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        filter.createdAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const users = await User.find(filter)
      .select('-password -plivoEndpointId -plivoEndpointUsername -plivoEndpointPassword')
      .populate('parent', 'name role email')
      .populate('roleRef', 'name level status')
      .populate('teams', 'name status')
      .populate('createdBy', 'name role email')
      .sort({ createdAt: -1 })
      .lean();
    return successResponse(res, 200, 'Users fetched successfully', users);
  } catch (error) {
    next(error);
  }
};

export const getUsersPaged = async (req, res, next) => {
  try {
    const { page, limit, skip, search } = parsePagination(req.query);
    const filter = {};
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      filter.$or = [{ name: pattern }, { email: pattern }, { phone: pattern }, { role: pattern }];
    }
    if (req.query.role && req.query.role !== 'all') filter.role = req.query.role;
    if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
    const [items, total] = await Promise.all([
      User.find(filter)
        .select('name email phone role roleRef teams permissionOverrides scopeOverrides parent createdBy status isActive createdAt')
        .populate('parent', 'name role email')
        .populate('roleRef', 'name level status')
        .populate('teams', 'name status')
        .populate('createdBy', 'name role email')
        .sort(safeSort(req.query, ['createdAt', 'name', 'role', 'status']))
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);
    return successResponse(res, 200, 'Users page fetched successfully', pagedData(
      items,
      paginationMeta({ page, limit, total }),
    ));
  } catch (error) {
    next(error);
  }
};

export const getUserOptions = async (req, res, next) => {
  try {
    const purpose = String(req.query.purpose || 'meeting');
    const search = String(req.query.search || '').trim();
    const filter = { isActive: true };
    if (purpose === 'team' || purpose === 'assignment') {
      const ownerId = await resolveAccountOwnerId(req.user);
      filter._id = { $in: await getAccountUserIds(ownerId) };
    }
    if (purpose === 'attendance') {
      const visibility = await resolveUserDataScope(req.user, 'attendance');
      if (visibility.scope === 'none') filter._id = { $exists: false };
      if (visibility.scope !== 'all' && visibility.scope !== 'none') {
        filter._id = { $in: visibility.userIds };
      }
    }
    if (purpose === 'manager') {
      filter.$or = [
        { role: { $regex: /^admin$/i } },
        { role: { $regex: /manager/i } },
        { role: { $regex: /^team[\s_-]*leader$/i } },
      ];
    } else if (purpose === 'attendance' || purpose === 'assignment') {
      filter.role = { $not: /^admin$/i };
    }
    if (search) {
      const pattern = new RegExp(escapeRegex(search), 'i');
      const textFilter = [{ name: pattern }, { email: pattern }];
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: textFilter }];
        delete filter.$or;
      } else {
        filter.$or = textFilter;
      }
    }
    let users;
    if (!search) {
      const version = await getReferenceCacheVersion();
      const cached = await withJsonCache(
        { key: cacheKeys.users(version, req.user._id, purpose), ttlSeconds: 300 },
        () => User.find(filter)
          .select('name email phone role parent status isActive')
          .sort({ name: 1 })
          .lean(),
      );
      users = cached.value;
    } else {
      users = await User.find(filter)
        .select('name email phone role parent status isActive')
        .sort({ name: 1 })
        .lean();
    }
    return successResponse(res, 200, 'User options fetched successfully', users);
  } catch (error) {
    next(error);
  }
};

// @desc    List users to whom the current user may delegate lead notification access
// @route   GET /api/users/lead-notification-delegates
// @access  Private
export const getLeadNotificationDelegates = async (req, res, next) => {
  try {
    const ownerId = await resolveAccountOwnerId(req.user);
    const accountIds = (await getAccountUserIds(ownerId)).map(String);
    let candidateIds = accountIds.filter((userId) => userId !== String(req.user._id));

    if (!isAdminUser(req.user)) {
      const managedTeams = await Team.find({
        manager: req.user._id,
        status: 'active',
      }).select('members').lean();
      const managedMemberIds = new Set(managedTeams.flatMap((team) => (
        (team.members || []).map(String)
      )));
      candidateIds = candidateIds.filter((userId) => managedMemberIds.has(userId));
    }

    const users = await User.find({
      _id: { $in: candidateIds },
      isActive: true,
      status: { $ne: 'inactive' },
      role: { $not: /^admin$/i },
    })
      .select('_id name email role roleRef teams permissionOverrides scopeOverrides status isActive')
      .sort({ name: 1 })
      .lean();
    const accessRows = await resolveEffectiveAccessMany(users);
    const delegates = users.map((user, index) => ({
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      enabled: userHasPermission(accessRows[index], PERMISSIONS.LEADS_MANAGE_NOTIFICATIONS),
    }));

    return successResponse(res, 200, 'Lead notification delegates fetched successfully', delegates);
  } catch (error) {
    next(error);
  }
};

// @desc    Delegate only the lead-notification permission to an eligible user
// @route   PUT /api/users/:id/lead-notification-access
// @access  Private
export const updateLeadNotificationAccess = async (req, res, next) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return errorResponse(res, 400, 'Access enabled value must be true or false');
    }
    if (String(req.params.id) === String(req.user._id)) {
      return errorResponse(res, 400, 'You cannot change your own delegated access');
    }

    const ownerId = await resolveAccountOwnerId(req.user);
    const accountIds = (await getAccountUserIds(ownerId)).map(String);
    if (!accountIds.includes(String(req.params.id))) {
      return errorResponse(res, 403, 'User is outside your account');
    }

    if (!isAdminUser(req.user)) {
      const managesTarget = await Team.exists({
        manager: req.user._id,
        members: req.params.id,
        status: 'active',
      });
      if (!managesTarget) {
        return errorResponse(res, 403, 'You can only delegate access to active members of your team');
      }
    }

    const user = await User.findOne({
      _id: req.params.id,
      isActive: true,
      status: { $ne: 'inactive' },
      role: { $not: /^admin$/i },
    });
    if (!user) return errorResponse(res, 404, 'Eligible user not found');

    const permission = PERMISSIONS.LEADS_MANAGE_NOTIFICATIONS;
    const allow = new Set(normalizePermissionList(user.permissionOverrides?.allow));
    const deny = new Set(normalizePermissionList(user.permissionOverrides?.deny));
    if (enabled) {
      allow.add(permission);
      deny.delete(permission);
    } else {
      allow.delete(permission);
      deny.add(permission);
    }
    user.permissionOverrides = { allow: [...allow], deny: [...deny] };
    await user.save();

    await logActivity({
      user: req.user._id,
      actionType: 'lead_notification_access_updated',
      description: `${enabled ? 'Granted' : 'Revoked'} lead notification access for ${user.name}`,
      entityType: 'User',
      entityId: user._id,
      metadata: { permission, enabled },
    });
    await Promise.all([
      invalidateAccessCaches(),
      invalidateAuthenticatedUserCache(user._id),
    ]);

    return successResponse(res, 200, `Lead notification access ${enabled ? 'granted' : 'revoked'}`, {
      _id: user._id,
      enabled,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create a new user
// @route   POST /api/users
// @access  Private
export const createUser = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      role,
      roleId,
      phone,
      parent,
      status,
      teamIds,
      permissionOverrides,
      scopeOverrides,
    } = req.body;

    const userExists = await User.findOne({ email });
    if (userExists) {
      return errorResponse(res, 400, 'User with this email already exists');
    }

    const roleDoc = await resolveRoleInput({ role, roleId });
    const assignedRole = roleDoc?.name || role;

    const user = await User.create({
      name,
      email,
      password,
      role: assignedRole,
      roleRef: roleDoc?._id || null,
      teams: Array.isArray(teamIds) ? teamIds : [],
      permissionOverrides: sanitizeOverrides(permissionOverrides),
      scopeOverrides: sanitizeDataScopes(scopeOverrides),
      phone,
      parent: parent || null,
      status: status || 'active',
      isActive: status !== 'inactive',
      createdBy: req.user._id,
    });

    // If the role exists in the Role collection, increment its usersCount
    await Role.findOneAndUpdate({ name: assignedRole }, { $inc: { usersCount: 1 } });
    await syncUserTeams(user._id, user.teams);

    // Sync to Employee collection
    const nameParts = name.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Doe';
    
    await Employee.create({
      firstName,
      lastName,
      email,
      phone: phone || 'N/A',
      designation: role || 'Employee',
      department: 'N/A',
      joiningDate: new Date(),
      user: user._id,
      createdBy: req.user._id
    });
    await reconcileUserEmployee(user, req.user._id);

    await logActivity({
      user: req.user._id,
      actionType: 'user_created',
      description: `Created user ${user.name}`,
      entityType: 'User',
      entityId: user._id,
      metadata: { role: user.role, parent: user.parent },
    });
    await Promise.all([invalidateUserReferenceCaches(), invalidateAccessCaches()]);

    const userObj = user.toJSON(); // toJSON removes password

    return successResponse(res, 201, 'User created successfully', userObj);
  } catch (error) {
    next(error);
  }
};

// @desc    Update user
// @route   PUT /api/users/:id
// @access  Private
export const updateUser = async (req, res, next) => {
  try {
    const {
      name,
      email,
      password,
      role,
      roleId,
      phone,
      parent,
      status,
      isActive,
      teamIds,
      permissionOverrides,
      scopeOverrides,
    } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }

    // Check duplicate email
    if (email && email !== user.email) {
      const emailExists = await User.findOne({ email });
      if (emailExists) {
        return errorResponse(res, 400, 'User with this email already exists');
      }
    }

    const oldRole = user.role;
    const oldEmail = user.email;

    user.name = name || user.name;
    user.email = email || user.email;
    user.phone = phone ?? user.phone;
    if (parent !== undefined) {
      user.parent = parent || null;
    }
    if (status) {
      user.status = status;
      user.isActive = status !== 'inactive';
    } else if (isActive !== undefined) {
      user.isActive = Boolean(isActive);
      user.status = user.isActive ? 'active' : 'inactive';
    }
    if (password) {
      user.password = password;
    }
    
    const roleDoc = (roleId || role)
      ? await resolveRoleInput({ role, roleId })
      : null;
    const nextRole = roleDoc?.name || role;
    if (nextRole && nextRole !== oldRole) {
      user.role = nextRole;
      user.roleRef = roleDoc?._id || null;
      await Role.findOneAndUpdate({ name: oldRole }, { $inc: { usersCount: -1 } });
      await Role.findOneAndUpdate({ name: nextRole }, { $inc: { usersCount: 1 } });
    } else if (roleDoc) {
      user.roleRef = roleDoc._id;
    }
    const pendingTeamIds = teamIds !== undefined
      ? Array.from(new Set((Array.isArray(teamIds) ? teamIds : []).map(String)))
      : null;
    if (pendingTeamIds) user.teams = pendingTeamIds;
    if (permissionOverrides !== undefined) {
      user.permissionOverrides = sanitizeOverrides(permissionOverrides);
    }
    if (scopeOverrides !== undefined) {
      user.scopeOverrides = sanitizeDataScopes(scopeOverrides);
    }

    await user.save();
    if (pendingTeamIds) await syncUserTeams(user._id, pendingTeamIds);

    // Sync updates to Employee
    const nameParts = user.name.split(' ');
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : 'Doe';
    
    await Employee.findOneAndUpdate(
      { email: oldEmail }, 
      { firstName, lastName, email: user.email, phone: user.phone || 'N/A', designation: user.role, user: user._id }
    );
    await reconcileUserEmployee(user, req.user._id);

    await logActivity({
      user: req.user._id,
      actionType: 'user_updated',
      description: `Updated user ${user.name}`,
      entityType: 'User',
      entityId: user._id,
      metadata: { oldRole, newRole: user.role, parent: user.parent, status: user.status },
    });
    await Promise.all([
      invalidateUserReferenceCaches(),
      invalidateAccessCaches(),
      invalidateAuthenticatedUserCache(user._id),
    ]);

    const userObj = user.toJSON();

    return successResponse(res, 200, 'User updated successfully', userObj);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private
export const deleteUser = async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return errorResponse(res, 404, 'User not found');
    }
    
    // Decrease usersCount in Role
    await Role.findOneAndUpdate({ name: user.role }, { $inc: { usersCount: -1 } });

    // Also delete the linked employee if one exists (by email)
    await Employee.findOneAndDelete({ email: user.email });
    await Promise.all([
      Team.updateMany({ members: user._id }, { $pull: { members: user._id } }),
      Team.updateMany({ manager: user._id }, { $set: { manager: null } }),
    ]);

    await User.findByIdAndDelete(req.params.id);
    await Promise.all([
      invalidateUserReferenceCaches(),
      invalidateAccessCaches(),
      invalidateAuthenticatedUserCache(req.params.id),
    ]);

    return successResponse(res, 200, 'User deleted successfully', null);
  } catch (error) {
    next(error);
  }
};
