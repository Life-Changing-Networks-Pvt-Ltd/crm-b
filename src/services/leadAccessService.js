import { resolveEffectiveAccess, getUserTeamMemberIds } from './accessControlService.js';
import { getDownlineUserIds, isAdminUser } from '../utils/hierarchy.js';
import mongoose from 'mongoose';
import { getAccessCacheVersion, withJsonCache } from './cacheService.js';

const cachedScopedUserIds = async (user, scope, producer) => {
  const version = await getAccessCacheVersion();
  const key = `lead-visibility:v${version}:${user._id}:${scope}`;
  const { value } = await withJsonCache({ key, ttlSeconds: 600 }, async () => (
    (await producer()).map(String)
  ));
  return value;
};

export const resolveLeadVisibility = async (user, resolvedAccess = null) => {
  if (isAdminUser(user)) {
    return { scope: 'all', userIds: [], query: {} };
  }

  const access = resolvedAccess || await resolveEffectiveAccess(user);
  const scope = access.scopes?.leads || 'own';

  if (scope === 'all') return { scope, userIds: [], query: {} };
  if (scope === 'none') {
    return { scope, userIds: [], query: { _id: { $exists: false } } };
  }

  let userIds = [user._id];
  if (scope === 'team') {
    userIds = await cachedScopedUserIds(user, scope, () => getUserTeamMemberIds(user));
  } else if (scope === 'hierarchy') {
    userIds = await cachedScopedUserIds(user, scope, () => getDownlineUserIds(user._id));
  }
  userIds = userIds
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  return {
    scope,
    userIds,
    query: {
      assignedTo: { $in: userIds },
    },
  };
};
