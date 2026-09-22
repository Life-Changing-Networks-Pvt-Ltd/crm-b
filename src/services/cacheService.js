import crypto from 'crypto';
import Redis from 'ioredis';

const inFlight = new Map();
const localCache = new Map();
const localCacheTtlSeconds = Math.max(
  1,
  Math.min(Number(process.env.LOCAL_CACHE_TTL_SECONDS || 15), 60),
);
const localCacheMaxEntries = Math.max(
  100,
  Number(process.env.LOCAL_CACHE_MAX_ENTRIES || 2_000),
);
let redisClient;
let redisDisabled = false;
let redisUnavailableLogged = false;
const cacheMetrics = {
  hits: 0,
  misses: 0,
  shared: 0,
  redisErrors: 0,
  redisBypasses: 0,
  writes: 0,
  localHits: 0,
  redisHits: 0,
};

export const getCacheMetrics = () => {
  const reads = cacheMetrics.hits + cacheMetrics.misses;
  return {
    ...cacheMetrics,
    reads,
    hitRatio: reads ? Number((cacheMetrics.hits / reads).toFixed(4)) : 0,
    inFlight: inFlight.size,
    localEntries: localCache.size,
  };
};

const getRedisUrl = () => {
  const explicitUrl = String(process.env.REDIS_URL || '').trim();
  if (explicitUrl) return explicitUrl;

  const host = String(process.env.REDIS_HOST || '').trim();
  if (!host) return '';

  const port = String(process.env.REDIS_PORT || '6379').trim() || '6379';
  const password = String(process.env.REDIS_PASSWORD || '').trim();
  const auth = password ? `:${encodeURIComponent(password)}@` : '';
  return `redis://${auth}${host}:${port}`;
};

const getRedisClient = () => {
  const redisUrl = getRedisUrl();
  if (!redisUrl) return null;
  if (redisClient) return redisClient;

  redisClient = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: 750,
    commandTimeout: 750,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redisClient.on('error', (error) => {
    if (!redisUnavailableLogged) {
      redisUnavailableLogged = true;
      console.warn('[MetricsCache] Redis unavailable; continuing without cache:', error.message);
    }
  });
  return redisClient;
};

const runRedis = async (operation) => {
  if (redisDisabled) {
    cacheMetrics.redisBypasses += 1;
    return null;
  }
  const client = getRedisClient();
  if (!client) {
    cacheMetrics.redisBypasses += 1;
    return null;
  }

  try {
    if (client.status === 'wait') await client.connect();
    if (client.status !== 'ready') return null;
    return await operation(client);
  } catch (error) {
    cacheMetrics.redisErrors += 1;
    redisDisabled = true;
    const retryTimer = setTimeout(() => {
      redisDisabled = false;
      redisUnavailableLogged = false;
    }, 10_000);
    retryTimer.unref?.();
    if (!redisUnavailableLogged) {
      redisUnavailableLogged = true;
      console.warn('[MetricsCache] Redis operation failed; continuing without cache:', error.message);
    }
    return null;
  }
};

const readLocal = (key) => {
  const entry = localCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    localCache.delete(key);
    return null;
  }
  return entry.value;
};

const writeLocal = (key, value, ttlSeconds) => {
  if (!localCache.has(key) && localCache.size >= localCacheMaxEntries) {
    const now = Date.now();
    for (const [existingKey, entry] of localCache) {
      if (entry.expiresAt <= now || localCache.size >= localCacheMaxEntries) {
        localCache.delete(existingKey);
      }
      if (localCache.size < localCacheMaxEntries) break;
    }
  }
  localCache.set(key, {
    value,
    expiresAt: Date.now() + (Math.min(ttlSeconds, localCacheTtlSeconds) * 1000),
  });
};

const readCachedJson = async (key) => {
  const local = readLocal(key);
  if (local !== null) return { found: true, value: local, source: 'local' };
  const cached = await runRedis((client) => client.get(key));
  if (!cached) return { found: false, value: null, source: null };
  try {
    const value = JSON.parse(cached);
    writeLocal(key, value, localCacheTtlSeconds);
    return { found: true, value, source: 'redis' };
  } catch {
    return { found: false, value: null, source: null };
  }
};

const recordCacheRead = ({ found, source }) => {
  if (found) {
    cacheMetrics.hits += 1;
    if (source === 'local') cacheMetrics.localHits += 1;
    if (source === 'redis') cacheMetrics.redisHits += 1;
  } else {
    cacheMetrics.misses += 1;
  }
};

export const getCachedJson = async (key) => {
  const result = await readCachedJson(key);
  recordCacheRead(result);
  return result.value;
};

export const getCachedJsonMany = async (keys = []) => {
  if (!keys.length) return [];
  const results = new Array(keys.length);
  const missingIndexes = [];
  keys.forEach((key, index) => {
    const value = readLocal(key);
    if (value === null) {
      missingIndexes.push(index);
    } else {
      results[index] = { found: true, value, source: 'local' };
    }
  });

  if (missingIndexes.length) {
    const missingKeys = missingIndexes.map((index) => keys[index]);
    const cachedRows = await runRedis((client) => client.mget(...missingKeys));
    missingIndexes.forEach((index, resultIndex) => {
      const cached = cachedRows?.[resultIndex];
      if (!cached) {
        results[index] = { found: false, value: null, source: null };
        return;
      }
      try {
        const value = JSON.parse(cached);
        writeLocal(keys[index], value, localCacheTtlSeconds);
        results[index] = { found: true, value, source: 'redis' };
      } catch {
        results[index] = { found: false, value: null, source: null };
      }
    });
  }

  results.forEach(recordCacheRead);
  return results.map((result) => result.value);
};

export const setCachedJson = async (key, value, ttlSeconds = 120) => {
  writeLocal(key, value, ttlSeconds);
  const writeResult = await runRedis((client) => client.set(key, JSON.stringify(value), 'EX', ttlSeconds));
  if (writeResult) cacheMetrics.writes += 1;
  return value;
};

export const setCachedJsonMany = async (entries = [], ttlSeconds = 120) => {
  const validEntries = entries.filter((entry) => entry?.key);
  if (!validEntries.length) return;
  validEntries.forEach(({ key, value }) => writeLocal(key, value, ttlSeconds));
  const result = await runRedis((client) => {
    const pipeline = client.pipeline();
    validEntries.forEach(({ key, value }) => {
      pipeline.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    });
    return pipeline.exec();
  });
  if (result) cacheMetrics.writes += validEntries.length;
};

export const deleteCachedKeys = async (...keys) => {
  const uniqueKeys = [...new Set(keys.flat().filter(Boolean))];
  uniqueKeys.forEach((key) => localCache.delete(key));
  if (uniqueKeys.length) await runRedis((client) => client.del(...uniqueKeys));
};

export const withJsonCache = async ({ key, ttlSeconds = 120 }, producer) => {
  const cached = await readCachedJson(key);
  recordCacheRead(cached);
  if (cached.found) return { value: cached.value, cacheStatus: 'hit' };
  if (inFlight.has(key)) {
    return { value: await inFlight.get(key), cacheStatus: 'shared' };
  }
  const pending = Promise.resolve().then(producer);
  inFlight.set(key, pending);
  try {
    const value = await pending;
    await setCachedJson(key, value, ttlSeconds);
    return { value, cacheStatus: 'miss' };
  } finally {
    inFlight.delete(key);
  }
};

let localAccessVersion = null;
export const getAccessCacheVersion = async () => {
  const sharedVersion = await runRedis((client) => client.get('crm:access:version'));
  if (sharedVersion !== null) localAccessVersion = Number(sharedVersion);
  localAccessVersion ??= 0;
  return localAccessVersion;
};

export const invalidateAccessCaches = async () => {
  const next = await runRedis((client) => client.incr('crm:access:version'));
  localAccessVersion = next === null ? (Number(localAccessVersion || 0) + 1) : Number(next);
};

export const cacheKeys = Object.freeze({
  authUser: (userId) => `auth:user:${userId}`,
  access: (version, userId) => `auth:access:v${version}:${userId}`,
  roles: (version) => `reference:v${version}:roles`,
  roleCatalog: (version) => `reference:v${version}:role-catalog`,
  teams: (version, ownerId, status) => `reference:v${version}:teams:${ownerId}:${status}`,
  users: (version, userId, purpose) => `reference:v${version}:users:${userId}:${purpose}`,
  settings: 'reference:settings',
});

export const invalidateAuthenticatedUserCache = async (userId) => {
  if (userId) await deleteCachedKeys(cacheKeys.authUser(String(userId)));
};

let localReferenceVersion = null;
export const getReferenceCacheVersion = async () => {
  const sharedVersion = await runRedis((client) => client.get('crm:reference:version'));
  if (sharedVersion !== null) localReferenceVersion = Number(sharedVersion);
  localReferenceVersion ??= 0;
  return localReferenceVersion;
};

export const invalidateReferenceCaches = async () => {
  const next = await runRedis((client) => client.incr('crm:reference:version'));
  localReferenceVersion = next === null ? Number(localReferenceVersion || 0) + 1 : Number(next);
};

export const invalidateUserReferenceCaches = invalidateReferenceCaches;
export const invalidateRoleReferenceCaches = invalidateReferenceCaches;
export const invalidateTeamReferenceCaches = invalidateReferenceCaches;

export const isFeatureEnabled = (name, defaultValue = true) => {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
};

export const stableFiltersHash = (filters = {}) => {
  const normalized = Object.keys(filters)
    .sort()
    .reduce((result, key) => {
      result[key] = filters[key] ?? '';
      return result;
    }, {});
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
};

const getMetricsVersion = async () => (
  await runRedis((client) => client.get('crm:lead-metrics:version')) || '0'
);

let localLeadDetailVersion = null;
const getLeadDetailVersion = async () => {
  const sharedVersion = await runRedis((client) => client.get('crm:lead-detail:version'));
  if (sharedVersion !== null) localLeadDetailVersion = Number(sharedVersion);
  localLeadDetailVersion ??= 0;
  return localLeadDetailVersion;
};

export const buildDashboardMetricsCacheKey = async ({
  userId,
  role,
  period,
  startDate,
  endDate,
  month,
  year,
  implementation = 'v2',
  accessScope = 'own',
  visibleUserIds = [],
}) => {
  const version = await getMetricsVersion();
  const visibilityHash = stableFiltersHash({ accessScope, visibleUserIds });
  return `dashboard:metrics:v${version}:${implementation}:${userId}:${role}:${period}:${startDate || ''}:${endDate || ''}:${month || ''}:${year || ''}:${visibilityHash}`;
};

export const buildLeadStatsCacheKey = async ({ userId, role, filters }) => {
  const version = await getMetricsVersion();
  return `leads:stats:v${version}:${userId}:${role}:${stableFiltersHash(filters)}`;
};

export const buildCompanyLeadsPageCacheKey = async ({
  userId,
  role,
  accessScope,
  visibleUserIds = [],
  filters,
}) => {
  const [dataVersion, accessVersion] = await Promise.all([
    getMetricsVersion(),
    getAccessCacheVersion(),
  ]);
  const visibilityHash = stableFiltersHash({
    accessScope,
    visibleUserIds: visibleUserIds.map(String).sort(),
  });
  return `company-leads:v${dataVersion}:a${accessVersion}:${userId}:${role}:${visibilityHash}:${stableFiltersHash(filters)}`;
};

export const buildLeadDetailCacheKey = async ({
  userId,
  role,
  accessScope,
  visibleUserIds = [],
  leadType,
  leadId,
}) => {
  const [dataVersion, accessVersion] = await Promise.all([
    getLeadDetailVersion(),
    getAccessCacheVersion(),
  ]);
  const visibilityHash = stableFiltersHash({
    accessScope,
    visibleUserIds: visibleUserIds.map(String).sort(),
  });
  return `lead-detail:v${dataVersion}:a${accessVersion}:${userId}:${role}:${visibilityHash}:${leadType}:${leadId}`;
};

export const withSafeCache = async ({ key, ttlSeconds = 45 }, producer) => {
  const cached = await readCachedJson(key);
  recordCacheRead(cached);
  if (cached.found) return { value: cached.value, cacheStatus: 'hit' };

  if (inFlight.has(key)) {
    cacheMetrics.shared += 1;
    return { value: await inFlight.get(key), cacheStatus: 'shared' };
  }

  const pending = Promise.resolve().then(producer);
  inFlight.set(key, pending);
  try {
    const value = await pending;
    await setCachedJson(key, value, ttlSeconds);
    return { value, cacheStatus: 'miss' };
  } finally {
    inFlight.delete(key);
  }
};

export const invalidateLeadMetricsCaches = async () => {
  const versions = await runRedis((client) => {
    const pipeline = client.pipeline();
    pipeline.incr('crm:lead-metrics:version');
    pipeline.incr('crm:lead-detail:version');
    return pipeline.exec();
  });
  const nextDetailVersion = versions?.[1]?.[1];
  localLeadDetailVersion = nextDetailVersion === undefined
    ? Number(localLeadDetailVersion || 0) + 1
    : Number(nextDetailVersion);
};

export const invalidateLeadDetailCaches = async () => {
  const next = await runRedis((client) => client.incr('crm:lead-detail:version'));
  localLeadDetailVersion = next === null
    ? Number(localLeadDetailVersion || 0) + 1
    : Number(next);
};

export const warmCacheConnection = async () => {
  const pong = await runRedis((client) => client.ping());
  return pong === 'PONG';
};

const cacheLogIntervalMs = Number(
  process.env.CACHE_METRICS_LOG_INTERVAL_MS
  || (process.env.NODE_ENV === 'production' ? 60_000 : 0),
);
if (cacheLogIntervalMs >= 10_000) {
  const timer = setInterval(() => {
    console.info(JSON.stringify({ event: 'cache_metrics', ...getCacheMetrics() }));
  }, cacheLogIntervalMs);
  timer.unref();
}
