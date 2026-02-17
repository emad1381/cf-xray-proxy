// src/config.ts
var BACKEND_ORIGIN = "http://127.0.0.1:10000";
var BACKEND_URL = BACKEND_ORIGIN;
var BACKEND_LIST = [BACKEND_ORIGIN];
var BACKEND_HEALTH_CHECK_INTERVAL = 3e4;
var BACKEND_STICKY_SESSION = false;
var MAX_RETRIES = 3;
var RATE_LIMIT_ENABLED = false;
var RATE_LIMIT_MAX_CONN_PER_IP = 5;
var RATE_LIMIT_MAX_CONN_PER_MIN = 10;
var UUID_MAX_CONNECTIONS = 0;
var DEFAULT_TRANSPORT = "xhttp";
var HIDE_BACKEND_URLS = "true";
var SUPPORTED_TRANSPORTS = ["xhttp", "httpupgrade", "ws"];

// src/utils/fetch.ts
var BACKEND_UPGRADE_TIMEOUT_MS = 5e3;
var BACKEND_PASSTHROUGH_TIMEOUT_MS = 15e3;
var BASE_RETRY_DELAY_MS = 150;
var MAX_RETRY_DELAY_MS = 2e3;
function normalizeRetryCount(maxRetries, fallback = MAX_RETRIES) {
  if (!Number.isFinite(maxRetries)) {
    return fallback;
  }
  return Math.max(0, Math.floor(maxRetries));
}
function getRetryBackoffDelayMs(attempt) {
  const exponent = Math.max(0, Math.floor(attempt));
  const exponentialDelayMs = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** exponent);
  const jitterSpreadMs = Math.max(1, Math.floor(exponentialDelayMs * 0.3));
  const jitterMs = Math.floor(Math.random() * jitterSpreadMs);
  return exponentialDelayMs + jitterMs;
}
async function waitForRetry(attempt) {
  const delayMs = getRetryBackoffDelayMs(attempt);
  await new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
async function fetchWithTimeout(input, init, timeoutMs, maxRetries = MAX_RETRIES) {
  const retryCount = normalizeRetryCount(maxRetries);
  let lastError = new Error("fetchWithTimeout failed without a captured error.");
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      lastError = error;
      if (attempt >= retryCount) {
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
    await waitForRetry(attempt);
  }
  throw lastError instanceof Error ? lastError : new Error("Backend request failed.");
}
function isAbortError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.name === "AbortError";
}

// src/backend.ts
var DEFAULT_BACKEND_WEIGHT = 1;
var HEALTH_CHECK_PATH = "/health";
var HEALTH_CHECK_TIMEOUT_MS = 4e3;
var BACKEND_FAILURE_HEADER_VALUE = "1";
var FAILURE_HYSTERESIS_COUNT = 1;
var RECOVERY_HYSTERESIS_COUNT = 2;
var ALIAS_MIN_SAMPLE_ATTEMPTS = 4;
var ALIAS_SAMPLE_ATTEMPTS_MULTIPLIER = 2;
var BACKEND_FAILURE_HEADER = "x-cf-xray-backend-failure";
function parseBoolean(value, fallback) {
  if (value === void 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}
function parseWeight(rawWeight) {
  if (!rawWeight) {
    return DEFAULT_BACKEND_WEIGHT;
  }
  const parsedWeight = Number(rawWeight);
  if (!Number.isFinite(parsedWeight) || !Number.isInteger(parsedWeight) || parsedWeight <= 0) {
    return DEFAULT_BACKEND_WEIGHT;
  }
  return parsedWeight;
}
function parseBackendList(rawBackendList) {
  return rawBackendList.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0).map((entry) => {
    const [rawUrl = "", rawWeight] = entry.split("|", 2).map((part) => part.trim());
    return {
      rawUrl,
      weight: parseWeight(rawWeight)
    };
  }).filter((entry) => entry.rawUrl.length > 0);
}
function toBackendConfigurations(env) {
  const fromBackendList = parseBackendList(env.BACKEND_LIST ?? "");
  if (fromBackendList.length > 0) {
    return fromBackendList;
  }
  const singleBackendUrl = env.BACKEND_URL?.trim();
  if (singleBackendUrl) {
    return [{ rawUrl: singleBackendUrl, weight: DEFAULT_BACKEND_WEIGHT }];
  }
  return BACKEND_LIST.map((rawUrl) => ({
    rawUrl,
    weight: DEFAULT_BACKEND_WEIGHT
  }));
}
function resolveHealthCheckIntervalMs(env) {
  const parsed = Number(env.BACKEND_HEALTH_CHECK_INTERVAL);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return BACKEND_HEALTH_CHECK_INTERVAL;
  }
  return Math.floor(parsed);
}
function resolveBackendLookupKey(url) {
  if (url instanceof URL) {
    return url.toString();
  }
  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}
function toResponseWithHeaders(response, headers) {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function buildAliasTable(candidates) {
  const size = candidates.length;
  if (size === 0) {
    return null;
  }
  if (size === 1) {
    const only = candidates[0];
    if (!only) {
      return null;
    }
    return {
      probabilities: [1],
      aliases: [0],
      backendIndexes: [only.index]
    };
  }
  const probabilities = new Array(size).fill(0);
  const aliases = new Array(size).fill(0);
  const backendIndexes = candidates.map((candidate) => candidate.index);
  let totalWeight = 0;
  for (const candidate of candidates) {
    totalWeight += Math.max(DEFAULT_BACKEND_WEIGHT, candidate.weight);
  }
  if (totalWeight <= 0) {
    for (let i = 0; i < size; i += 1) {
      probabilities[i] = 1;
      aliases[i] = i;
    }
    return {
      probabilities,
      aliases,
      backendIndexes
    };
  }
  const scaled = new Array(size).fill(0);
  const small = [];
  const large = [];
  for (let i = 0; i < size; i += 1) {
    const candidate = candidates[i];
    const weight = Math.max(DEFAULT_BACKEND_WEIGHT, candidate?.weight ?? DEFAULT_BACKEND_WEIGHT);
    const normalizedWeight = weight * size / totalWeight;
    scaled[i] = normalizedWeight;
    if (normalizedWeight < 1) {
      small.push(i);
    } else {
      large.push(i);
    }
  }
  while (small.length > 0 && large.length > 0) {
    const less = small.pop();
    const more = large.pop();
    if (less === void 0 || more === void 0) {
      break;
    }
    probabilities[less] = scaled[less] ?? 0;
    aliases[less] = more;
    const updated = (scaled[more] ?? 0) + (scaled[less] ?? 0) - 1;
    scaled[more] = updated;
    if (updated < 1) {
      small.push(more);
    } else {
      large.push(more);
    }
  }
  while (large.length > 0) {
    const index = large.pop();
    if (index !== void 0) {
      probabilities[index] = 1;
      aliases[index] = index;
    }
  }
  while (small.length > 0) {
    const index = small.pop();
    if (index !== void 0) {
      probabilities[index] = 1;
      aliases[index] = index;
    }
  }
  return {
    probabilities,
    aliases,
    backendIndexes
  };
}
function sampleAliasTable(table) {
  const size = table.backendIndexes.length;
  if (size === 0) {
    return -1;
  }
  if (size === 1) {
    return table.backendIndexes[0] ?? -1;
  }
  const bucket = Math.floor(Math.random() * size);
  const threshold = table.probabilities[bucket] ?? 1;
  const aliasPosition = table.aliases[bucket] ?? bucket;
  const selectedPosition = Math.random() < threshold ? bucket : aliasPosition;
  return table.backendIndexes[selectedPosition] ?? -1;
}
var MinIndexHeap = class {
  heap = [];
  positions = /* @__PURE__ */ new Map();
  clear() {
    this.heap.length = 0;
    this.positions.clear();
  }
  peek() {
    return this.heap[0] ?? null;
  }
  insert(value) {
    if (this.positions.has(value)) {
      return;
    }
    const position = this.heap.length;
    this.heap.push(value);
    this.positions.set(value, position);
    this.siftUp(position);
  }
  remove(value) {
    const position = this.positions.get(value);
    if (position === void 0) {
      return;
    }
    const lastIndex = this.heap.length - 1;
    const lastValue = this.heap[lastIndex];
    this.positions.delete(value);
    if (position === lastIndex) {
      this.heap.pop();
      return;
    }
    if (lastValue === void 0) {
      this.heap.pop();
      return;
    }
    this.heap[position] = lastValue;
    this.positions.set(lastValue, position);
    this.heap.pop();
    const parent = Math.floor((position - 1) / 2);
    if (position > 0 && (this.heap[parent] ?? Number.POSITIVE_INFINITY) > lastValue) {
      this.siftUp(position);
    } else {
      this.siftDown(position);
    }
  }
  siftUp(start) {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const currentValue = this.heap[index] ?? Number.POSITIVE_INFINITY;
      const parentValue = this.heap[parent] ?? Number.POSITIVE_INFINITY;
      if (parentValue <= currentValue) {
        break;
      }
      this.swap(index, parent);
      index = parent;
    }
  }
  siftDown(start) {
    let index = start;
    let shouldContinue = true;
    while (shouldContinue) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if ((this.heap[left] ?? Number.POSITIVE_INFINITY) < (this.heap[smallest] ?? Number.POSITIVE_INFINITY)) {
        smallest = left;
      }
      if ((this.heap[right] ?? Number.POSITIVE_INFINITY) < (this.heap[smallest] ?? Number.POSITIVE_INFINITY)) {
        smallest = right;
      }
      if (smallest === index) {
        shouldContinue = false;
        continue;
      }
      this.swap(index, smallest);
      index = smallest;
    }
  }
  swap(first, second) {
    const firstValue = this.heap[first];
    const secondValue = this.heap[second];
    if (firstValue === void 0 || secondValue === void 0) {
      return;
    }
    this.heap[first] = secondValue;
    this.heap[second] = firstValue;
    this.positions.set(firstValue, second);
    this.positions.set(secondValue, first);
  }
};
function withBackendFailureMarker(response) {
  const headers = new Headers(response.headers);
  headers.set(BACKEND_FAILURE_HEADER, BACKEND_FAILURE_HEADER_VALUE);
  return toResponseWithHeaders(response, headers);
}
function isBackendFailureResponse(response) {
  return response.headers.get(BACKEND_FAILURE_HEADER) === BACKEND_FAILURE_HEADER_VALUE;
}
function stripBackendFailureMarker(response) {
  if (!isBackendFailureResponse(response)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete(BACKEND_FAILURE_HEADER);
  return toResponseWithHeaders(response, headers);
}
function resolveMaxRetryAttempts(env) {
  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}
var BackendManager = class {
  backends;
  backendByUrl = /* @__PURE__ */ new Map();
  healthCheckIntervalMs;
  stickySession;
  debugEnabled;
  healthyAliasTable = null;
  allAliasTable = null;
  healthyIndexHeap = new MinIndexHeap();
  healthCheckInFlight = false;
  nextHealthCheckAt = 0;
  constructor(env) {
    this.debugEnabled = env.DEBUG === "true";
    this.backends = this.initializeBackends(env);
    this.healthCheckIntervalMs = resolveHealthCheckIntervalMs(env);
    this.stickySession = this.backends.length > 1 && parseBoolean(env.BACKEND_STICKY_SESSION, BACKEND_STICKY_SESSION);
    this.rebuildSelectionStructures();
    this.nextHealthCheckAt = Date.now() + this.healthCheckIntervalMs;
  }
  /**
   * Selects a backend using sticky-first or weighted-random strategy.
   * Selection is O(1) expected when no exclusions are provided.
   */
  getBackend(excludedUrls = []) {
    this.maybeRunScheduledHealthChecks();
    const excluded = new Set(
      excludedUrls.map((url) => resolveBackendLookupKey(url)).filter((url) => url !== null)
    );
    const healthyCandidate = this.pickHealthy(excluded);
    if (healthyCandidate) {
      return healthyCandidate;
    }
    const fallbackCandidate = this.pickAny(excluded);
    if (fallbackCandidate) {
      return fallbackCandidate;
    }
    return this.backends[0] ?? this.createFallbackBackend();
  }
  /**
   * Marks a backend as failed. One failure is enough to trigger fast failover.
   */
  markFailed(url) {
    const backend = this.lookupBackend(url);
    if (!backend) {
      return;
    }
    backend.lastCheck = Date.now();
    backend.failures += 1;
    backend.consecutiveFailures += 1;
    backend.consecutiveSuccesses = 0;
    const shouldFlipHealth = backend.healthy && backend.consecutiveFailures >= FAILURE_HYSTERESIS_COUNT;
    if (!shouldFlipHealth) {
      return;
    }
    backend.healthy = false;
    this.rebuildHealthySelectionStructures();
    if (this.debugEnabled) {
      console.warn("[backend] marked unhealthy after failure", {
        backendUrl: backend.url.toString(),
        failures: backend.failures
      });
    }
  }
  /**
   * Marks a backend as healthy after a successful attempt.
   */
  markHealthy(url) {
    const backend = this.lookupBackend(url);
    if (!backend) {
      return;
    }
    backend.lastCheck = Date.now();
    backend.failures = 0;
    backend.consecutiveFailures = 0;
    backend.consecutiveSuccesses = RECOVERY_HYSTERESIS_COUNT;
    if (backend.healthy) {
      return;
    }
    backend.healthy = true;
    this.rebuildHealthySelectionStructures();
    if (this.debugEnabled) {
      console.info("[backend] marked healthy", {
        backendUrl: backend.url.toString()
      });
    }
  }
  /**
   * Returns backend health snapshots for observability endpoints.
   */
  getStates() {
    return this.backends.map((backend) => ({
      url: backend.url.toString(),
      healthy: backend.healthy,
      lastCheckedAt: backend.lastCheck,
      failureCount: backend.failures
    }));
  }
  initializeBackends(env) {
    const parsedConfigurations = toBackendConfigurations(env);
    const now = Date.now();
    for (const configuration of parsedConfigurations) {
      try {
        const parsedUrl = new URL(configuration.rawUrl);
        const key = parsedUrl.toString();
        const existing = this.backendByUrl.get(key);
        if (existing) {
          existing.weight += configuration.weight;
          continue;
        }
        const backend = {
          index: this.backendByUrl.size,
          key,
          url: parsedUrl,
          weight: configuration.weight,
          healthy: true,
          lastCheck: now,
          failures: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0
        };
        this.backendByUrl.set(key, backend);
      } catch {
        if (this.debugEnabled) {
          console.warn("[backend] skipping invalid BACKEND_LIST entry", configuration.rawUrl);
        }
      }
    }
    if (this.backendByUrl.size === 0) {
      const fallbackUrl = new URL(BACKEND_URL);
      const key = fallbackUrl.toString();
      this.backendByUrl.set(key, {
        index: 0,
        key,
        url: fallbackUrl,
        weight: DEFAULT_BACKEND_WEIGHT,
        healthy: true,
        lastCheck: now,
        failures: 0,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0
      });
    }
    const backends = Array.from(this.backendByUrl.values()).sort((first, second) => first.index - second.index);
    for (let index = 0; index < backends.length; index += 1) {
      const backend = backends[index];
      if (!backend) {
        continue;
      }
      backend.index = index;
    }
    return backends;
  }
  createFallbackBackend() {
    const fallbackUrl = new URL(BACKEND_URL);
    return {
      url: fallbackUrl,
      weight: DEFAULT_BACKEND_WEIGHT,
      healthy: true,
      lastCheck: Date.now(),
      failures: 0
    };
  }
  lookupBackend(url) {
    const lookupKey = resolveBackendLookupKey(url);
    if (!lookupKey) {
      return null;
    }
    return this.backendByUrl.get(lookupKey) ?? null;
  }
  rebuildSelectionStructures() {
    this.allAliasTable = buildAliasTable(this.backends);
    this.rebuildHealthySelectionStructures();
  }
  rebuildHealthySelectionStructures() {
    const healthyBackends = [];
    this.healthyIndexHeap.clear();
    for (const backend of this.backends) {
      if (!backend.healthy) {
        continue;
      }
      healthyBackends.push(backend);
      this.healthyIndexHeap.insert(backend.index);
    }
    this.healthyAliasTable = buildAliasTable(healthyBackends);
  }
  pickHealthy(excluded) {
    if (this.stickySession) {
      return this.pickStickyHealthy(excluded);
    }
    return this.pickFromAlias(this.healthyAliasTable, excluded);
  }
  pickAny(excluded) {
    if (this.stickySession) {
      return this.pickByOrder(this.backends, excluded, false);
    }
    return this.pickFromAlias(this.allAliasTable, excluded);
  }
  pickStickyHealthy(excluded) {
    const topHealthyIndex = this.healthyIndexHeap.peek();
    if (topHealthyIndex !== null) {
      const candidate = this.backends[topHealthyIndex];
      if (candidate && candidate.healthy && !excluded.has(candidate.key)) {
        return candidate;
      }
    }
    return this.pickByOrder(this.backends, excluded, true);
  }
  pickByOrder(candidates, excluded, healthyOnly) {
    for (const candidate of candidates) {
      if (healthyOnly && !candidate.healthy) {
        continue;
      }
      if (!excluded.has(candidate.key)) {
        return candidate;
      }
    }
    return null;
  }
  pickFromAlias(table, excluded) {
    if (!table || table.backendIndexes.length === 0) {
      return null;
    }
    if (excluded.size === 0) {
      const selectedIndex = sampleAliasTable(table);
      return selectedIndex >= 0 ? this.backends[selectedIndex] ?? null : null;
    }
    const sampleAttempts = Math.max(
      ALIAS_MIN_SAMPLE_ATTEMPTS,
      table.backendIndexes.length * ALIAS_SAMPLE_ATTEMPTS_MULTIPLIER
    );
    for (let attempt = 0; attempt < sampleAttempts; attempt += 1) {
      const selectedIndex = sampleAliasTable(table);
      if (selectedIndex < 0) {
        continue;
      }
      const candidate = this.backends[selectedIndex];
      if (!candidate || excluded.has(candidate.key)) {
        continue;
      }
      return candidate;
    }
    for (const backendIndex of table.backendIndexes) {
      const candidate = this.backends[backendIndex];
      if (!candidate || excluded.has(candidate.key)) {
        continue;
      }
      return candidate;
    }
    return null;
  }
  maybeRunScheduledHealthChecks() {
    const now = Date.now();
    if (this.healthCheckInFlight || now < this.nextHealthCheckAt) {
      return;
    }
    this.nextHealthCheckAt = now + this.healthCheckIntervalMs;
    void this.runHealthChecks();
  }
  async runHealthChecks() {
    if (this.healthCheckInFlight) {
      return;
    }
    this.healthCheckInFlight = true;
    try {
      const changes = await Promise.all(this.backends.map((backend) => this.checkBackendHealth(backend)));
      if (changes.some((changed) => changed)) {
        this.rebuildHealthySelectionStructures();
      }
    } finally {
      this.healthCheckInFlight = false;
    }
  }
  async checkBackendHealth(backend) {
    const checkUrl = new URL(HEALTH_CHECK_PATH, backend.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, HEALTH_CHECK_TIMEOUT_MS);
    let isHealthyResult = false;
    try {
      const response = await fetch(checkUrl.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "cache-control": "no-cache"
        },
        signal: controller.signal
      });
      isHealthyResult = response.status < 500;
      await response.body?.cancel();
    } catch {
      isHealthyResult = false;
    } finally {
      clearTimeout(timeout);
    }
    return this.applyHealthProbeResult(backend, isHealthyResult);
  }
  applyHealthProbeResult(backend, isHealthyResult) {
    backend.lastCheck = Date.now();
    if (isHealthyResult) {
      backend.consecutiveSuccesses += 1;
      backend.consecutiveFailures = 0;
      if (backend.healthy) {
        backend.failures = 0;
        return false;
      }
      if (backend.consecutiveSuccesses < RECOVERY_HYSTERESIS_COUNT) {
        return false;
      }
      backend.healthy = true;
      backend.failures = 0;
      if (this.debugEnabled) {
        console.info("[backend] health check recovered backend", {
          backendUrl: backend.url.toString()
        });
      }
      return true;
    }
    backend.consecutiveFailures += 1;
    backend.consecutiveSuccesses = 0;
    backend.failures += 1;
    if (!backend.healthy || backend.consecutiveFailures < FAILURE_HYSTERESIS_COUNT) {
      return false;
    }
    backend.healthy = false;
    if (this.debugEnabled) {
      console.warn("[backend] health check marked backend unhealthy", {
        backendUrl: backend.url.toString(),
        failures: backend.failures
      });
    }
    return true;
  }
};

// src/ratelimit.ts
var ONE_MINUTE_MS = 6e4;
var CLEANUP_INTERVAL_MS = 3e4;
var IDLE_STATE_TTL_MS = ONE_MINUTE_MS;
var CONCURRENT_LIMIT_RETRY_AFTER_SECONDS = 10;
var UNKNOWN_IP = "unknown";
var TOKEN_EPSILON = 1e-9;
function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}
function normalizeIp(ip) {
  const trimmed = ip.trim();
  return trimmed.length > 0 ? trimmed : UNKNOWN_IP;
}
function resolveRateLimitConfig(env) {
  const enabledRaw = (env.RATE_LIMIT_ENABLED ?? String(RATE_LIMIT_ENABLED)).trim().toLowerCase();
  const enabled = enabledRaw === "true";
  return {
    enabled,
    maxConnPerIp: parsePositiveInteger(env.RATE_LIMIT_MAX_CONN_PER_IP, RATE_LIMIT_MAX_CONN_PER_IP),
    maxConnPerMin: parsePositiveInteger(env.RATE_LIMIT_MAX_CONN_PER_MIN, RATE_LIMIT_MAX_CONN_PER_MIN)
  };
}
var ConnectionRateLimiter = class {
  maxConnPerIp;
  maxConnPerMin;
  bucketCapacity;
  refillTokensPerMs;
  stateByIp = /* @__PURE__ */ new Map();
  nextCleanupAt = 0;
  constructor(maxConnPerIp, maxConnPerMin) {
    this.maxConnPerIp = Math.max(1, maxConnPerIp);
    this.maxConnPerMin = Math.max(1, maxConnPerMin);
    this.bucketCapacity = this.maxConnPerMin;
    this.refillTokensPerMs = this.maxConnPerMin / ONE_MINUTE_MS;
    this.nextCleanupAt = Date.now() + CLEANUP_INTERVAL_MS;
  }
  /**
   * Returns true when a new connection is allowed for the given IP.
   */
  checkConnectionAllowed(ip) {
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedIp = normalizeIp(ip);
    const state = this.getOrCreateState(normalizedIp, now);
    this.refillTokens(state, now);
    state.lastSeenAt = now;
    if (state.activeConnectionIds.size >= this.maxConnPerIp) {
      return false;
    }
    return state.tokens + TOKEN_EPSILON >= 1;
  }
  /**
   * Tracks a newly accepted connection for the given IP.
   */
  registerConnection(ip, connId) {
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedIp = normalizeIp(ip);
    const state = this.getOrCreateState(normalizedIp, now);
    this.refillTokens(state, now);
    if (state.activeConnectionIds.has(connId)) {
      state.lastSeenAt = now;
      return;
    }
    state.activeConnectionIds.add(connId);
    if (state.tokens + TOKEN_EPSILON >= 1) {
      state.tokens = Math.max(0, state.tokens - 1);
    } else {
      state.tokens = 0;
    }
    state.lastSeenAt = now;
  }
  /**
   * Removes an active connection entry after a socket closes.
   */
  unregisterConnection(ip, connId) {
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedIp = normalizeIp(ip);
    const state = this.stateByIp.get(normalizedIp);
    if (!state) {
      return;
    }
    if (state.activeConnectionIds.delete(connId)) {
      state.lastSeenAt = now;
    }
    this.deleteIfIdle(normalizedIp, state, now);
  }
  /**
   * Removes stale per-IP state older than one minute when idle.
   */
  cleanupOldAttempts() {
    const now = Date.now();
    for (const [ip, state] of this.stateByIp) {
      this.refillTokens(state, now);
      this.deleteIfIdle(ip, state, now);
    }
    this.nextCleanupAt = now + CLEANUP_INTERVAL_MS;
  }
  /**
   * Returns Retry-After seconds for blocked IP addresses.
   */
  getRetryAfterSeconds(ip) {
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedIp = normalizeIp(ip);
    const state = this.stateByIp.get(normalizedIp);
    if (!state) {
      return 1;
    }
    this.refillTokens(state, now);
    if (state.activeConnectionIds.size >= this.maxConnPerIp) {
      return CONCURRENT_LIMIT_RETRY_AFTER_SECONDS;
    }
    if (state.tokens + TOKEN_EPSILON >= 1) {
      return 1;
    }
    const missingTokens = Math.max(0, 1 - state.tokens);
    const refillMs = this.refillTokensPerMs > 0 ? missingTokens / this.refillTokensPerMs : ONE_MINUTE_MS;
    const boundedMs = Math.max(1e3, refillMs);
    return Math.max(1, Math.ceil(boundedMs / 1e3));
  }
  maybeCleanup(now) {
    if (now < this.nextCleanupAt) {
      return;
    }
    this.cleanupOldAttempts();
  }
  getOrCreateState(ip, now) {
    const existing = this.stateByIp.get(ip);
    if (existing) {
      return existing;
    }
    const created = {
      activeConnectionIds: /* @__PURE__ */ new Set(),
      tokens: this.bucketCapacity,
      lastRefillAt: now,
      lastSeenAt: now
    };
    this.stateByIp.set(ip, created);
    return created;
  }
  refillTokens(state, now) {
    if (now <= state.lastRefillAt) {
      return;
    }
    const elapsedMs = now - state.lastRefillAt;
    const replenished = elapsedMs * this.refillTokensPerMs;
    state.tokens = Math.min(this.bucketCapacity, state.tokens + replenished);
    state.lastRefillAt = now;
  }
  deleteIfIdle(ip, state, now) {
    if (state.activeConnectionIds.size > 0) {
      return;
    }
    const isRefilled = state.tokens >= this.bucketCapacity - TOKEN_EPSILON;
    const isExpired = now - state.lastSeenAt >= IDLE_STATE_TTL_MS;
    if (isRefilled && isExpired) {
      this.stateByIp.delete(ip);
    }
  }
};

// src/utils/response.ts
function textResponse(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

// src/utils/socket.ts
function hasUpgradeRequest(request, strictWebSocketUpgrade) {
  const connectionHasUpgrade = request.headers.get("Connection")?.toLowerCase().includes("upgrade") ?? false;
  const upgrade = request.headers.get("Upgrade");
  if (!connectionHasUpgrade || !upgrade) {
    return false;
  }
  if (!strictWebSocketUpgrade) {
    return true;
  }
  return upgrade.toLowerCase() === "websocket";
}
function parseBackendList2(rawBackendList) {
  return rawBackendList.split(",").map((entry) => entry.trim()).map((entry) => (entry.split("|", 2)[0] ?? "").trim()).filter((url) => url.length > 0);
}
function resolveBackendUrl(env) {
  const configuredBackendUrl = env.BACKEND_URL?.trim();
  if (configuredBackendUrl) {
    return configuredBackendUrl;
  }
  const configuredBackendList = parseBackendList2(env.BACKEND_LIST ?? "");
  const defaultBackendList = BACKEND_LIST.map((url) => url.trim()).filter((url) => url.length > 0);
  return configuredBackendList[0] ?? defaultBackendList[0] ?? BACKEND_URL;
}
function parseBackendUrl(request, env, inbound = new URL(request.url)) {
  const rawBackendUrl = resolveBackendUrl(env);
  let backendUrl;
  try {
    backendUrl = new URL(rawBackendUrl);
  } catch {
    throw new Error("BACKEND_URL is not a valid URL.");
  }
  backendUrl.pathname = inbound.pathname;
  backendUrl.search = inbound.search;
  return backendUrl;
}
function parseBackendUrlWithOverride(backendBaseUrl, inbound) {
  const rawBackendUrl = backendBaseUrl instanceof URL ? backendBaseUrl.toString() : backendBaseUrl;
  let backendUrl;
  try {
    backendUrl = new URL(rawBackendUrl);
  } catch {
    throw new Error("BACKEND_URL is not a valid URL.");
  }
  backendUrl.pathname = inbound.pathname;
  backendUrl.search = inbound.search;
  return backendUrl;
}
function buildBackendPassthroughHeaders(request) {
  const headers = new Headers(request.headers);
  headers.delete("Host");
  return headers;
}
function toPassthroughInit(request, headers) {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return {
      method,
      headers,
      redirect: "manual"
    };
  }
  return {
    method,
    headers,
    body: request.body,
    redirect: "manual"
  };
}
function sanitizeCloseCode(code) {
  if (Number.isInteger(code) && code >= 1e3 && code <= 4999 && code !== 1005 && code !== 1006) {
    return code;
  }
  return 1011;
}
function closeSocketPair(firstSocket, secondSocket, code, reason) {
  safeClose(firstSocket, code, reason);
  safeClose(secondSocket, code, reason);
}
function safeClose(socket, code, reason) {
  const normalizedCode = sanitizeCloseCode(code);
  const normalizedReason = reason.slice(0, 123);
  try {
    socket.close(normalizedCode, normalizedReason);
  } catch {
    try {
      socket.close();
    } catch {
    }
  }
}
function toSocketConnectionState(readyState) {
  switch (readyState) {
    case 0:
      return "connecting";
    case 1:
      return "open";
    case 2:
      return "closing";
    case 3:
      return "closed";
    default:
      return "errored";
  }
}
function formatConnectionState(state) {
  return `client=${state.client}, backend=${state.backend}`;
}
function bridgeSockets(clientSocket, backendSocket, onRelayError, onClosed, onReady) {
  let closed = false;
  let onClosedNotified = false;
  let cleanupListeners = () => void 0;
  const state = {
    client: toSocketConnectionState(clientSocket.readyState),
    backend: toSocketConnectionState(backendSocket.readyState)
  };
  const closeBoth = (code, reason) => {
    if (closed) {
      return;
    }
    closed = true;
    state.client = state.client === "closed" ? "closed" : "closing";
    state.backend = state.backend === "closed" ? "closed" : "closing";
    cleanupListeners();
    closeSocketPair(clientSocket, backendSocket, code, reason);
    state.client = "closed";
    state.backend = "closed";
    if (!onClosedNotified && onClosed) {
      onClosedNotified = true;
      try {
        onClosed();
      } catch {
      }
    }
  };
  const onForwardFailure = (direction, error) => {
    onRelayError(direction, error);
    closeBoth(1011, "Relay failure");
  };
  const forward = (destination, payload, direction) => {
    if (payload instanceof Blob) {
      void payload.arrayBuffer().then((arrayBuffer) => {
        if (closed) {
          return;
        }
        try {
          destination.send(arrayBuffer);
        } catch (error) {
          onForwardFailure(direction, error);
        }
      }).catch((error) => {
        onForwardFailure(direction, error);
      });
      return;
    }
    if (closed || destination.readyState !== 1) {
      return;
    }
    try {
      destination.send(payload);
    } catch (error) {
      onForwardFailure(direction, error);
    }
  };
  const onClientMessage = (event) => {
    forward(backendSocket, event.data, "client->backend");
  };
  const onBackendMessage = (event) => {
    forward(clientSocket, event.data, "backend->client");
  };
  const onClientClose = (event) => {
    state.client = "closed";
    closeBoth(event.code, event.reason || "Client closed connection");
  };
  const onBackendClose = (event) => {
    state.backend = "closed";
    closeBoth(event.code, event.reason || "Backend closed connection");
  };
  const onClientError = () => {
    state.client = "errored";
    onRelayError(
      "client->backend",
      new Error(`Client socket error (${formatConnectionState(state)})`)
    );
    closeBoth(1011, "Client socket error");
  };
  const onBackendError = () => {
    state.backend = "errored";
    onRelayError(
      "backend->client",
      new Error(`Backend socket error (${formatConnectionState(state)})`)
    );
    closeBoth(1011, "Backend socket error");
  };
  cleanupListeners = () => {
    clientSocket.removeEventListener("message", onClientMessage);
    backendSocket.removeEventListener("message", onBackendMessage);
    clientSocket.removeEventListener("close", onClientClose);
    backendSocket.removeEventListener("close", onBackendClose);
    clientSocket.removeEventListener("error", onClientError);
    backendSocket.removeEventListener("error", onBackendError);
  };
  clientSocket.addEventListener("message", onClientMessage);
  backendSocket.addEventListener("message", onBackendMessage);
  clientSocket.addEventListener("close", onClientClose);
  backendSocket.addEventListener("close", onBackendClose);
  clientSocket.addEventListener("error", onClientError);
  backendSocket.addEventListener("error", onBackendError);
  if (onReady) {
    try {
      onReady((code, reason) => {
        closeBoth(code, reason);
      });
    } catch {
    }
  }
}

// src/utils/ws-protocol.ts
var SEC_WEBSOCKET_PROTOCOL_HEADER = "sec-websocket-protocol";
var SEC_WEBSOCKET_EXTENSIONS_HEADER = "sec-websocket-extensions";
var KNOWN_PROTOCOL_NEGOTIATION_TOKENS = /* @__PURE__ */ new Set(["trojan", "vless", "vmess"]);
function isLikelyBase64UrlToken(value) {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}
function decodeBase64UrlToUint8Array(base64Url) {
  const normalized = base64Url.replace(/-/g, "+").replace(/_/g, "/");
  const paddingNeeded = (4 - normalized.length % 4) % 4;
  const padded = normalized + "=".repeat(paddingNeeded);
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}
function encodeUint8ArrayToBase64Url(input) {
  let binary = "";
  for (const value of input) {
    binary += String.fromCharCode(value);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function isCanonicalBase64UrlToken(token) {
  try {
    const decoded = decodeBase64UrlToUint8Array(token);
    return encodeUint8ArrayToBase64Url(decoded) === token;
  } catch {
    return false;
  }
}
function parseWebSocketProtocolHeader(headerValue) {
  const tokens = (headerValue ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const negotiationTokens = [];
  const auxiliaryTokens = [];
  for (const token of tokens) {
    if (KNOWN_PROTOCOL_NEGOTIATION_TOKENS.has(token.toLowerCase())) {
      negotiationTokens.push(token);
      continue;
    }
    auxiliaryTokens.push(token);
  }
  return {
    tokens,
    negotiationTokens,
    auxiliaryTokens
  };
}
function buildBackendUpgradeHeaders(request, upgradeValue = "websocket") {
  const headers = new Headers(request.headers);
  headers.delete("Host");
  headers.set("Connection", "Upgrade");
  headers.set("Upgrade", upgradeValue);
  headers.delete(SEC_WEBSOCKET_EXTENSIONS_HEADER);
  const parsedProtocolHeader = parseWebSocketProtocolHeader(headers.get(SEC_WEBSOCKET_PROTOCOL_HEADER));
  if (parsedProtocolHeader.tokens.length === 0) {
    headers.delete("Sec-WebSocket-Protocol");
  } else {
    headers.set("Sec-WebSocket-Protocol", parsedProtocolHeader.tokens.join(", "));
  }
  return headers;
}
function parseEarlyDataFromWebSocketProtocolHeader(headerValue, maxBytes) {
  if (maxBytes <= 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }
  const parsedProtocolHeader = parseWebSocketProtocolHeader(headerValue);
  if (parsedProtocolHeader.tokens.length === 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }
  if (parsedProtocolHeader.negotiationTokens.length > 0) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }
  if (parsedProtocolHeader.tokens.length !== 1) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }
  const token = parsedProtocolHeader.tokens[0];
  if (!token || !isLikelyBase64UrlToken(token) || !isCanonicalBase64UrlToken(token)) {
    return { data: null, errorMessage: null, shouldStripProtocolHeader: false };
  }
  const decoded = decodeBase64UrlToUint8Array(token);
  if (decoded.byteLength > maxBytes) {
    return {
      data: null,
      errorMessage: `xhttp early-data exceeds limit (${decoded.byteLength} > ${maxBytes} bytes).`,
      shouldStripProtocolHeader: false
    };
  }
  return {
    data: decoded,
    errorMessage: null,
    shouldStripProtocolHeader: true
  };
}

// src/transports/httpupgrade.ts
function isDebugEnabled(env) {
  return env.DEBUG === "true";
}
function validateRequest(request) {
  void request;
  return null;
}
function resolveMaxAttempts(env, backendOverride) {
  if (backendOverride) {
    return 1;
  }
  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}
function shouldRetryUpgradeStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}
async function handleUpgrade(request, env, backendOverride, onConnectionClosed, onConnectionReady) {
  const validationError = validateRequest(request);
  if (validationError) {
    return validationError;
  }
  const debugEnabled = isDebugEnabled(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, false);
  let backendUrl;
  try {
    backendUrl = backendOverride ? parseBackendUrlWithOverride(backendOverride, requestUrl) : parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : "Invalid backend configuration.");
  }
  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);
    if (debugEnabled) {
      console.log("[httpupgrade]", "forwarding non-upgrade httpupgrade request", {
        backendUrl: backendUrl.toString(),
        method: request.method
      });
    }
    try {
      return await fetchWithTimeout(
        backendUrl.toString(),
        toPassthroughInit(request, passthroughHeaders),
        BACKEND_PASSTHROUGH_TIMEOUT_MS
      );
    } catch (error) {
      if (isAbortError(error)) {
        return withBackendFailureMarker(textResponse(502, "Backend request timed out."));
      }
      if (debugEnabled) {
        console.error("[httpupgrade] backend passthrough error", error);
      }
      return withBackendFailureMarker(textResponse(502, "Unable to connect to backend service."));
    }
  }
  if (request.method.toUpperCase() !== "GET") {
    return textResponse(400, "httpupgrade upgrade requests must use GET.");
  }
  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();
  const backendHeaders = buildBackendUpgradeHeaders(request, request.headers.get("Upgrade") ?? "websocket");
  const maxAttempts = resolveMaxAttempts(env, backendOverride);
  let lastStatus = null;
  let lastError = null;
  let lastErrorWasTimeout = false;
  if (debugEnabled) {
    console.log("[httpupgrade]", "dialing backend", {
      backendUrl: backendUrl.toString(),
      upgrade: backendHeaders.get("Upgrade"),
      maxAttempts
    });
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const backendResponse = await fetchWithTimeout(
        backendUrl.toString(),
        {
          method: "GET",
          headers: backendHeaders,
          redirect: "manual"
        },
        BACKEND_UPGRADE_TIMEOUT_MS,
        0
      );
      if (backendResponse.status !== 101 || !backendResponse.webSocket) {
        lastStatus = backendResponse.status;
        await backendResponse.body?.cancel();
        const shouldRetry = attempt < maxAttempts && shouldRetryUpgradeStatus(backendResponse.status);
        if (!shouldRetry) {
          closeSocketPair(
            workerSocket,
            clientSocket,
            1011,
            `Backend upgrade rejected (${backendResponse.status})`
          );
          return withBackendFailureMarker(
            textResponse(
              502,
              `Backend failed to upgrade httpupgrade connection (status ${backendResponse.status}, attempt ${attempt}/${maxAttempts}).`
            )
          );
        }
        if (debugEnabled) {
          console.warn("[httpupgrade] backend rejected upgrade attempt", {
            backendUrl: backendUrl.toString(),
            status: backendResponse.status,
            attempt,
            maxAttempts
          });
        }
      } else {
        const backendSocket = backendResponse.webSocket;
        try {
          backendSocket.accept();
          bridgeSockets(
            workerSocket,
            backendSocket,
            (direction, error) => {
              if (debugEnabled) {
                console.log("[httpupgrade]", "relay error", { direction, error });
              }
            },
            onConnectionClosed,
            onConnectionReady
          );
          return new Response(null, {
            status: 101,
            webSocket: clientSocket
          });
        } catch (error) {
          safeClose(backendSocket, 1011, "Failed to initialize httpupgrade bridge");
          throw error;
        }
      }
    } catch (error) {
      lastError = error;
      lastErrorWasTimeout = isAbortError(error);
      if (debugEnabled) {
        console.error("[httpupgrade] backend connection attempt failed", {
          backendUrl: backendUrl.toString(),
          attempt,
          maxAttempts,
          error
        });
      }
      if (attempt >= maxAttempts) {
        break;
      }
    }
    if (attempt < maxAttempts) {
      await waitForRetry(attempt - 1);
    }
  }
  closeSocketPair(workerSocket, clientSocket, 1011, "Unable to connect to backend");
  if (lastErrorWasTimeout) {
    return withBackendFailureMarker(
      textResponse(502, `Backend httpupgrade timed out after ${maxAttempts} attempts.`)
    );
  }
  if (lastStatus !== null) {
    return withBackendFailureMarker(
      textResponse(
        502,
        `Backend httpupgrade failed after ${maxAttempts} attempts (status ${lastStatus}).`
      )
    );
  }
  if (debugEnabled && lastError) {
    console.error("[httpupgrade] backend connection error", lastError);
  }
  return withBackendFailureMarker(
    textResponse(
      502,
      `Unable to connect to backend service for httpupgrade transport after ${maxAttempts} attempts.`
    )
  );
}

// src/transports/ws.ts
function isDebugEnabled2(env) {
  return env.DEBUG === "true";
}
function validateRequest2(request) {
  void request;
  return null;
}
function resolveMaxAttempts2(env, backendOverride) {
  if (backendOverride) {
    return 1;
  }
  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}
function shouldRetryUpgradeStatus2(status) {
  return status === 408 || status === 429 || status >= 500;
}
async function handleUpgrade2(request, env, backendOverride, onConnectionClosed, onConnectionReady) {
  const validationError = validateRequest2(request);
  if (validationError) {
    return validationError;
  }
  const debugEnabled = isDebugEnabled2(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, true);
  let backendUrl;
  try {
    backendUrl = backendOverride ? parseBackendUrlWithOverride(backendOverride, requestUrl) : parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : "Invalid backend configuration.");
  }
  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);
    if (debugEnabled) {
      console.log("[ws]", "forwarding non-upgrade ws request", {
        backendUrl: backendUrl.toString(),
        method: request.method
      });
    }
    try {
      return await fetchWithTimeout(
        backendUrl.toString(),
        toPassthroughInit(request, passthroughHeaders),
        BACKEND_PASSTHROUGH_TIMEOUT_MS
      );
    } catch (error) {
      if (isAbortError(error)) {
        return withBackendFailureMarker(textResponse(502, "Backend request timed out."));
      }
      if (debugEnabled) {
        console.error("[ws] backend passthrough error", error);
      }
      return withBackendFailureMarker(textResponse(502, "Unable to connect to backend service."));
    }
  }
  if (request.method.toUpperCase() !== "GET") {
    return textResponse(400, "ws upgrade requests must use GET.");
  }
  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();
  const backendHeaders = buildBackendUpgradeHeaders(request);
  const maxAttempts = resolveMaxAttempts2(env, backendOverride);
  let lastStatus = null;
  let lastError = null;
  let lastErrorWasTimeout = false;
  if (debugEnabled) {
    console.log("[ws]", "dialing backend", {
      backendUrl: backendUrl.toString(),
      subprotocol: backendHeaders.get("sec-websocket-protocol") ?? "none",
      maxAttempts
    });
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const backendResponse = await fetchWithTimeout(
        backendUrl.toString(),
        {
          method: "GET",
          headers: backendHeaders,
          redirect: "manual"
        },
        BACKEND_UPGRADE_TIMEOUT_MS,
        0
      );
      if (backendResponse.status !== 101 || !backendResponse.webSocket) {
        lastStatus = backendResponse.status;
        await backendResponse.body?.cancel();
        const shouldRetry = attempt < maxAttempts && shouldRetryUpgradeStatus2(backendResponse.status);
        if (!shouldRetry) {
          closeSocketPair(
            workerSocket,
            clientSocket,
            1011,
            `Backend upgrade rejected (${backendResponse.status})`
          );
          return withBackendFailureMarker(
            textResponse(
              502,
              `Backend failed to upgrade ws connection (status ${backendResponse.status}, attempt ${attempt}/${maxAttempts}).`
            )
          );
        }
        if (debugEnabled) {
          console.warn("[ws] backend rejected upgrade attempt", {
            backendUrl: backendUrl.toString(),
            status: backendResponse.status,
            attempt,
            maxAttempts
          });
        }
      } else {
        const backendSocket = backendResponse.webSocket;
        try {
          backendSocket.accept();
          bridgeSockets(
            workerSocket,
            backendSocket,
            (direction, error) => {
              if (debugEnabled) {
                console.log("[ws]", "relay error", { direction, error });
              }
            },
            onConnectionClosed,
            onConnectionReady
          );
          return new Response(null, {
            status: 101,
            webSocket: clientSocket
          });
        } catch (error) {
          safeClose(backendSocket, 1011, "Failed to initialize ws bridge");
          throw error;
        }
      }
    } catch (error) {
      lastError = error;
      lastErrorWasTimeout = isAbortError(error);
      if (debugEnabled) {
        console.error("[ws] backend connection attempt failed", {
          backendUrl: backendUrl.toString(),
          attempt,
          maxAttempts,
          error
        });
      }
      if (attempt >= maxAttempts) {
        break;
      }
    }
    if (attempt < maxAttempts) {
      await waitForRetry(attempt - 1);
    }
  }
  closeSocketPair(workerSocket, clientSocket, 1011, "Unable to connect to backend");
  if (lastErrorWasTimeout) {
    return withBackendFailureMarker(textResponse(502, `Backend ws upgrade timed out after ${maxAttempts} attempts.`));
  }
  if (lastStatus !== null) {
    return withBackendFailureMarker(
      textResponse(502, `Backend ws upgrade failed after ${maxAttempts} attempts (status ${lastStatus}).`)
    );
  }
  if (debugEnabled && lastError) {
    console.error("[ws] backend connection error", lastError);
  }
  return withBackendFailureMarker(
    textResponse(502, `Unable to connect to backend service for ws transport after ${maxAttempts} attempts.`)
  );
}

// src/transports/xhttp.ts
var MAX_EARLY_DATA_BYTES = 64 * 1024;
var ALLOWED_MODES = ["auto", "packet-up"];
function isDebugEnabled3(env) {
  return env.DEBUG === "true";
}
function validateRequest3(request) {
  void request;
  return null;
}
function resolveMaxAttempts3(env, backendOverride) {
  if (backendOverride) {
    return 1;
  }
  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}
function shouldRetryUpgradeStatus3(status) {
  return status === 408 || status === 429 || status >= 500;
}
function parseEarlyDataHint(url) {
  const raw = url.searchParams.get("ed");
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error("Invalid early-data hint. The ed query parameter must be a non-negative integer.");
  }
  return Math.min(parsed, MAX_EARLY_DATA_BYTES);
}
function parseMode(url, request) {
  const fromQuery = url.searchParams.get("mode")?.toLowerCase();
  const fromHeader = request.headers.get("x-xhttp-mode")?.toLowerCase();
  const mode = fromQuery ?? fromHeader ?? "auto";
  if (ALLOWED_MODES.includes(mode)) {
    return mode;
  }
  throw new Error("Invalid xhttp mode. Supported values are auto and packet-up.");
}
async function handleUpgrade3(request, env, backendOverride, onConnectionClosed, onConnectionReady) {
  const validationError = validateRequest3(request);
  if (validationError) {
    return validationError;
  }
  const debugEnabled = isDebugEnabled3(env);
  const requestUrl = new URL(request.url);
  const hasUpgrade = hasUpgradeRequest(request, true);
  let earlyDataHint;
  let mode;
  if (hasUpgrade) {
    try {
      earlyDataHint = parseEarlyDataHint(requestUrl);
      mode = parseMode(requestUrl, request);
    } catch (error) {
      return textResponse(400, error instanceof Error ? error.message : "Invalid xhttp options.");
    }
  } else {
    earlyDataHint = 0;
    mode = "auto";
  }
  let backendUrl;
  try {
    backendUrl = backendOverride ? parseBackendUrlWithOverride(backendOverride, requestUrl) : parseBackendUrl(request, env, requestUrl);
  } catch (error) {
    return textResponse(500, error instanceof Error ? error.message : "Invalid backend configuration.");
  }
  if (!hasUpgrade) {
    const passthroughHeaders = buildBackendPassthroughHeaders(request);
    if (debugEnabled) {
      console.log("[xhttp]", "forwarding non-upgrade xhttp request", {
        backendUrl: backendUrl.toString(),
        method: request.method
      });
    }
    try {
      return await fetchWithTimeout(
        backendUrl.toString(),
        toPassthroughInit(request, passthroughHeaders),
        BACKEND_PASSTHROUGH_TIMEOUT_MS
      );
    } catch (error) {
      if (isAbortError(error)) {
        return withBackendFailureMarker(textResponse(502, "Backend request timed out."));
      }
      if (debugEnabled) {
        console.error("[xhttp] backend passthrough error", error);
      }
      return withBackendFailureMarker(textResponse(502, "Unable to connect to backend service."));
    }
  }
  const socketPair = new WebSocketPair();
  const clientSocket = socketPair[0];
  const workerSocket = socketPair[1];
  workerSocket.accept();
  const backendHeaders = buildBackendUpgradeHeaders(request);
  const maxAttempts = resolveMaxAttempts3(env, backendOverride);
  let lastStatus = null;
  let lastError = null;
  let lastErrorWasTimeout = false;
  let earlyDataForwardFailed = false;
  const earlyDataResult = parseEarlyDataFromWebSocketProtocolHeader(
    request.headers.get(SEC_WEBSOCKET_PROTOCOL_HEADER),
    earlyDataHint
  );
  if (earlyDataResult.errorMessage) {
    closeSocketPair(workerSocket, clientSocket, 1002, "Invalid early-data");
    return textResponse(400, earlyDataResult.errorMessage);
  }
  const earlyDataChunk = earlyDataResult.data;
  if (earlyDataResult.shouldStripProtocolHeader) {
    backendHeaders.delete(SEC_WEBSOCKET_PROTOCOL_HEADER);
  }
  if (debugEnabled) {
    console.log("[xhttp]", "dialing backend", {
      backendUrl: backendUrl.toString(),
      mode,
      earlyDataHint,
      earlyDataBytes: earlyDataChunk?.byteLength ?? 0,
      maxAttempts
    });
  }
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const backendResponse = await fetchWithTimeout(
        backendUrl.toString(),
        {
          method: "GET",
          headers: backendHeaders,
          redirect: "manual"
        },
        BACKEND_UPGRADE_TIMEOUT_MS,
        0
      );
      if (backendResponse.status !== 101 || !backendResponse.webSocket) {
        lastStatus = backendResponse.status;
        await backendResponse.body?.cancel();
        const shouldRetry = attempt < maxAttempts && shouldRetryUpgradeStatus3(backendResponse.status);
        if (!shouldRetry) {
          closeSocketPair(
            workerSocket,
            clientSocket,
            1011,
            `Backend upgrade rejected (${backendResponse.status})`
          );
          return withBackendFailureMarker(
            textResponse(
              502,
              `Backend failed to upgrade xhttp connection (status ${backendResponse.status}, mode ${mode}, attempt ${attempt}/${maxAttempts}).`
            )
          );
        }
        if (debugEnabled) {
          console.warn("[xhttp] backend rejected upgrade attempt", {
            backendUrl: backendUrl.toString(),
            status: backendResponse.status,
            mode,
            attempt,
            maxAttempts
          });
        }
      } else {
        const backendSocket = backendResponse.webSocket;
        try {
          backendSocket.accept();
          if (earlyDataChunk && earlyDataChunk.byteLength > 0) {
            try {
              backendSocket.send(earlyDataChunk);
            } catch (error) {
              earlyDataForwardFailed = true;
              throw error;
            }
          }
          bridgeSockets(
            workerSocket,
            backendSocket,
            (direction, error) => {
              if (debugEnabled) {
                console.log("[xhttp]", "relay error", { direction, error });
              }
            },
            onConnectionClosed,
            onConnectionReady
          );
          return new Response(null, {
            status: 101,
            webSocket: clientSocket
          });
        } catch (error) {
          safeClose(
            backendSocket,
            1011,
            earlyDataForwardFailed ? "Failed to forward early-data" : "Failed to initialize xhttp bridge"
          );
          throw error;
        }
      }
    } catch (error) {
      lastError = error;
      lastErrorWasTimeout = isAbortError(error);
      if (debugEnabled) {
        console.error("[xhttp] backend connection attempt failed", {
          backendUrl: backendUrl.toString(),
          mode,
          attempt,
          maxAttempts,
          error
        });
      }
      if (attempt >= maxAttempts) {
        break;
      }
    }
    if (attempt < maxAttempts) {
      await waitForRetry(attempt - 1);
    }
  }
  closeSocketPair(workerSocket, clientSocket, 1011, "Unable to connect to backend");
  if (earlyDataForwardFailed) {
    return withBackendFailureMarker(
      textResponse(502, `Failed to forward xhttp early-data after ${maxAttempts} attempts.`)
    );
  }
  if (lastErrorWasTimeout) {
    return withBackendFailureMarker(textResponse(502, `Backend xhttp upgrade timed out after ${maxAttempts} attempts.`));
  }
  if (lastStatus !== null) {
    return withBackendFailureMarker(
      textResponse(
        502,
        `Backend xhttp upgrade failed after ${maxAttempts} attempts (status ${lastStatus}, mode ${mode}).`
      )
    );
  }
  if (debugEnabled && lastError) {
    console.error("[xhttp] backend connection error", lastError);
  }
  return withBackendFailureMarker(
    textResponse(
      502,
      `Unable to connect to backend service for xhttp transport after ${maxAttempts} attempts.`
    )
  );
}

// src/uuid-manager.ts
var UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var UUID_REPLACED_CLOSE_CODE = 1008;
var UUID_REPLACED_CLOSE_REASON = "Connection replaced by a newer session.";
var UUID_CLEANUP_INTERVAL_MS = 6e4;
var UUID_ENTRY_STALE_MS = 7 * 24 * 60 * 60 * 1e3;
var UUID_IDLE_BUCKET_TTL_MS = 10 * 6e4;
var UUID_MAX_TRACKED_BUCKETS = 1e4;
var UUID_STALE_CLOSE_CODE = 1001;
var UUID_STALE_CLOSE_REASON = "Stale connection cleanup.";
function parseNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}
function normalizeIp2(ip) {
  const trimmed = ip.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : "unknown";
}
function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
function isValidUuid(value) {
  return UUID_REGEX.test(value.trim());
}
function normalizeUuid(value) {
  return value.trim().toLowerCase();
}
function extractUuidFromPath(url) {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0).map(decodePathSegment);
  const first = segments[0];
  if (first && isValidUuid(first)) {
    return normalizeUuid(first);
  }
  const second = segments[1];
  if (first?.toLowerCase() === "sub" && second && isValidUuid(second)) {
    return normalizeUuid(second);
  }
  return null;
}
function resolveUuidMaxConnections(env) {
  return parseNonNegativeInteger(env.UUID_MAX_CONNECTIONS, UUID_MAX_CONNECTIONS);
}
function extractUuidFromRequest(request) {
  const url = new URL(request.url);
  const fromQuery = url.searchParams.get("id");
  if (fromQuery && isValidUuid(fromQuery)) {
    return normalizeUuid(fromQuery);
  }
  return extractUuidFromPath(url);
}
var UUIDConnectionManager = class {
  maxConnections;
  debugEnabled;
  bucketsByUuid = /* @__PURE__ */ new Map();
  uuidByConnectionId = /* @__PURE__ */ new Map();
  nextCleanupAt = 0;
  constructor(maxConnections, debugEnabled) {
    this.maxConnections = Math.max(0, maxConnections);
    this.debugEnabled = debugEnabled;
    this.nextCleanupAt = Date.now() + UUID_CLEANUP_INTERVAL_MS;
  }
  isEnabled() {
    return this.maxConnections > 0;
  }
  /**
   * Returns true if a new connection is allowed for UUID/IP pair.
   * Same-IP reconnect is always allowed (existing one will be replaced).
   */
  checkConnectionAllowed(uuid, ip) {
    if (!this.isEnabled()) {
      return true;
    }
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedUuid = normalizeUuid(uuid);
    const normalizedIp = normalizeIp2(ip);
    const bucket = this.bucketsByUuid.get(normalizedUuid);
    if (!bucket) {
      return true;
    }
    bucket.lastTouchedAt = now;
    if (bucket.byConnectionId.size < this.maxConnections) {
      return true;
    }
    if (bucket.byIp.has(normalizedIp)) {
      return true;
    }
    if (this.debugEnabled) {
      console.warn("[uuid] rejecting connection", {
        uuid: normalizedUuid,
        ip: normalizedIp,
        activeConnections: bucket.byConnectionId.size,
        maxConnections: this.maxConnections
      });
    }
    return false;
  }
  /**
   * Registers a UUID connection and replaces existing same-IP sessions.
   */
  registerConnection(uuid, ip, connectionId, disconnect) {
    if (!this.isEnabled()) {
      return;
    }
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedUuid = normalizeUuid(uuid);
    const normalizedIp = normalizeIp2(ip);
    const bucket = this.getOrCreateBucket(normalizedUuid, now);
    const sameIpConnections = bucket.byIp.get(normalizedIp);
    if (sameIpConnections && sameIpConnections.size > 0) {
      for (const existingConnectionId of Array.from(sameIpConnections)) {
        this.removeConnection(
          normalizedUuid,
          bucket,
          existingConnectionId,
          true,
          UUID_REPLACED_CLOSE_CODE,
          UUID_REPLACED_CLOSE_REASON,
          true
        );
      }
    }
    if (bucket.byConnectionId.size >= this.maxConnections && !bucket.byIp.has(normalizedIp)) {
      if (this.debugEnabled) {
        console.warn("[uuid] register skipped due to full bucket", {
          uuid: normalizedUuid,
          ip: normalizedIp,
          connectionId,
          activeConnections: bucket.byConnectionId.size,
          maxConnections: this.maxConnections
        });
      }
      return;
    }
    const existingUuid = this.uuidByConnectionId.get(connectionId);
    if (existingUuid) {
      const existingBucket = this.bucketsByUuid.get(existingUuid);
      if (existingBucket) {
        this.removeConnection(existingUuid, existingBucket, connectionId, false);
      } else {
        this.uuidByConnectionId.delete(connectionId);
      }
    }
    const tracked = {
      connectionId,
      ip: normalizedIp,
      timestamp: now
    };
    if (disconnect) {
      tracked.disconnect = disconnect;
    }
    bucket.byConnectionId.set(connectionId, tracked);
    let ipSet = bucket.byIp.get(normalizedIp);
    if (!ipSet) {
      ipSet = /* @__PURE__ */ new Set();
      bucket.byIp.set(normalizedIp, ipSet);
    }
    ipSet.add(connectionId);
    bucket.lastTouchedAt = now;
    this.uuidByConnectionId.set(connectionId, normalizedUuid);
    this.evictIdleBucketsIfNeeded(now);
  }
  /**
   * Unregisters an active UUID connection entry.
   */
  unregisterConnection(uuid, connectionId) {
    if (!this.isEnabled()) {
      return;
    }
    const now = Date.now();
    this.maybeCleanup(now);
    const normalizedUuid = normalizeUuid(uuid);
    const bucket = this.bucketsByUuid.get(normalizedUuid);
    if (!bucket) {
      this.uuidByConnectionId.delete(connectionId);
      return;
    }
    this.removeConnection(normalizedUuid, bucket, connectionId, false);
    bucket.lastTouchedAt = now;
    if (bucket.byConnectionId.size === 0) {
      this.bucketsByUuid.delete(normalizedUuid);
    }
  }
  getOrCreateBucket(uuid, now) {
    const existing = this.bucketsByUuid.get(uuid);
    if (existing) {
      existing.lastTouchedAt = now;
      return existing;
    }
    const created = {
      byConnectionId: /* @__PURE__ */ new Map(),
      byIp: /* @__PURE__ */ new Map(),
      lastTouchedAt: now
    };
    this.bucketsByUuid.set(uuid, created);
    return created;
  }
  removeConnection(uuid, bucket, connectionId, invokeDisconnect, closeCode = UUID_REPLACED_CLOSE_CODE, closeReason = UUID_REPLACED_CLOSE_REASON, keepBucketWhenEmpty = false) {
    const connection = bucket.byConnectionId.get(connectionId);
    if (!connection) {
      this.uuidByConnectionId.delete(connectionId);
      return;
    }
    bucket.byConnectionId.delete(connectionId);
    this.uuidByConnectionId.delete(connectionId);
    const ipConnections = bucket.byIp.get(connection.ip);
    if (ipConnections) {
      ipConnections.delete(connectionId);
      if (ipConnections.size === 0) {
        bucket.byIp.delete(connection.ip);
      }
    }
    if (invokeDisconnect) {
      try {
        connection.disconnect?.(closeCode, closeReason);
      } catch {
      }
    }
    if (!keepBucketWhenEmpty && bucket.byConnectionId.size === 0) {
      this.bucketsByUuid.delete(uuid);
    }
  }
  maybeCleanup(now) {
    if (now < this.nextCleanupAt) {
      return;
    }
    this.cleanup(now);
  }
  cleanup(now) {
    for (const [uuid, bucket] of this.bucketsByUuid) {
      const staleConnectionIds = [];
      for (const [connectionId, connection] of bucket.byConnectionId) {
        const ageMs = now - connection.timestamp;
        if (ageMs < UUID_ENTRY_STALE_MS) {
          continue;
        }
        staleConnectionIds.push(connectionId);
      }
      for (const connectionId of staleConnectionIds) {
        this.removeConnection(uuid, bucket, connectionId, true, UUID_STALE_CLOSE_CODE, UUID_STALE_CLOSE_REASON);
      }
      if (bucket.byConnectionId.size > 0) {
        continue;
      }
      if (now - bucket.lastTouchedAt >= UUID_IDLE_BUCKET_TTL_MS) {
        this.bucketsByUuid.delete(uuid);
      }
    }
    this.evictIdleBucketsIfNeeded(now);
    this.nextCleanupAt = now + UUID_CLEANUP_INTERVAL_MS;
  }
  evictIdleBucketsIfNeeded(now) {
    if (this.bucketsByUuid.size <= UUID_MAX_TRACKED_BUCKETS) {
      return;
    }
    const idleCandidates = [];
    for (const [uuid, bucket] of this.bucketsByUuid) {
      if (bucket.byConnectionId.size > 0) {
        continue;
      }
      idleCandidates.push({
        uuid,
        lastTouchedAt: bucket.lastTouchedAt
      });
    }
    if (idleCandidates.length === 0) {
      return;
    }
    idleCandidates.sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);
    for (const candidate of idleCandidates) {
      if (this.bucketsByUuid.size <= UUID_MAX_TRACKED_BUCKETS) {
        break;
      }
      if (now - candidate.lastTouchedAt < UUID_IDLE_BUCKET_TTL_MS) {
        continue;
      }
      this.bucketsByUuid.delete(candidate.uuid);
    }
  }
};

// src/subscription/config.ts
var DEFAULT_SUBSCRIPTION_ENABLED = false;
var DEFAULT_SUBSCRIPTION_PRESERVE_DOMAIN = false;
var DEFAULT_SUBSCRIPTION_TRANSFORM = false;
var DEFAULT_SUBSCRIPTION_CACHE_TTL_MS = 5 * 6e4;
var MAX_PORT = 65535;
function parseBoolean2(value, fallback) {
  if (value === void 0) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") {
    return true;
  }
  if (normalized === "false") {
    return false;
  }
  return fallback;
}
function parsePort(rawPort) {
  const numericPort = typeof rawPort === "number" ? rawPort : Number(rawPort);
  if (!Number.isFinite(numericPort) || !Number.isInteger(numericPort)) {
    return null;
  }
  if (numericPort < 1 || numericPort > MAX_PORT) {
    return null;
  }
  return numericPort;
}
function normalizePath(rawPath) {
  const value = (rawPath ?? "").trim();
  if (!value) {
    return "/sub";
  }
  if (value.startsWith("/")) {
    return value;
  }
  return `/${value}`;
}
function parseBaseUrl(rawUrl) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
function toSubscriptionTarget(name, rawUrl, rawPort, rawPath) {
  const normalizedName = name.trim().toLowerCase();
  const parsedUrl = parseBaseUrl(rawUrl);
  if (!normalizedName || !parsedUrl) {
    return null;
  }
  const parsedPort = parsePort(rawPort) ?? parsePort(parsedUrl.port) ?? (parsedUrl.protocol === "https:" ? 443 : 80);
  if (!parsedPort) {
    return null;
  }
  parsedUrl.pathname = "/";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return {
    name: normalizedName,
    url: parsedUrl.toString(),
    port: parsedPort,
    path: normalizePath(rawPath)
  };
}
function parseTargetsFromJson(rawTargets) {
  let parsed;
  try {
    parsed = JSON.parse(rawTargets);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const targets = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const input = entry;
    const name = typeof input.name === "string" ? input.name : "";
    const url = typeof input.url === "string" ? input.url : "";
    const path = typeof input.path === "string" ? input.path : void 0;
    const port = typeof input.port === "number" || typeof input.port === "string" ? input.port : void 0;
    const target = toSubscriptionTarget(name, url, port, path);
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}
function parseTargetsFromDelimited(rawTargets) {
  const entries = rawTargets.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  const targets = [];
  for (const entry of entries) {
    const [name = "", url = "", port = "", path = ""] = entry.split("|", 4).map((part) => part.trim());
    const target = toSubscriptionTarget(name, url, port, path);
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}
function dedupeTargets(targets) {
  const deduped = /* @__PURE__ */ new Map();
  for (const target of targets) {
    if (!deduped.has(target.name)) {
      deduped.set(target.name, target);
    }
  }
  return Array.from(deduped.values());
}
function parseSubscriptionTargets(rawTargets) {
  const normalized = (rawTargets ?? "").trim();
  if (!normalized) {
    return [];
  }
  const fromJson = parseTargetsFromJson(normalized);
  if (fromJson.length > 0) {
    return dedupeTargets(fromJson);
  }
  return dedupeTargets(parseTargetsFromDelimited(normalized));
}
function resolveSubscriptionConfig(env) {
  const enabled = parseBoolean2(env.SUBSCRIPTION_ENABLED, DEFAULT_SUBSCRIPTION_ENABLED);
  if (!enabled) {
    return {
      enabled: false,
      preserveDomain: false,
      targets: []
    };
  }
  return {
    enabled: true,
    preserveDomain: parseBoolean2(env.SUBSCRIPTION_PRESERVE_DOMAIN, DEFAULT_SUBSCRIPTION_PRESERVE_DOMAIN),
    targets: parseSubscriptionTargets(env.SUBSCRIPTION_TARGETS)
  };
}
function resolveSubscriptionTransform(env) {
  return parseBoolean2(env.SUBSCRIPTION_TRANSFORM, DEFAULT_SUBSCRIPTION_TRANSFORM);
}
function resolveSubscriptionCacheTtlMs(env) {
  const parsed = Number(env.SUBSCRIPTION_CACHE_TTL_MS);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_SUBSCRIPTION_CACHE_TTL_MS;
  }
  return parsed;
}

// src/subscription/cache.ts
var DEFAULT_CACHE_TTL_MS = 5 * 6e4;
var DEFAULT_MAX_CACHE_ENTRIES = 256;
var DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024;
var DEFAULT_ENTRY_SIZE_BYTES = 4 * 1024;
var CLEANUP_INTERVAL_MS2 = 3e4;
function buildCacheKey(service, token) {
  return `${service.toLowerCase()}:${token}`;
}
function parseContentLength(headerValue) {
  if (!headerValue) {
    return null;
  }
  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}
function estimateResponseSize(response) {
  const fromHeader = parseContentLength(response.headers.get("content-length"));
  if (fromHeader !== null) {
    return fromHeader;
  }
  return DEFAULT_ENTRY_SIZE_BYTES;
}
var SubscriptionCache = class {
  ttlMs;
  maxEntries;
  maxBytes;
  nodesByKey = /* @__PURE__ */ new Map();
  head = null;
  tail = null;
  totalBytes = 0;
  nextCleanupAt = 0;
  constructor(ttlMs = DEFAULT_CACHE_TTL_MS, maxEntries = DEFAULT_MAX_CACHE_ENTRIES, maxBytes = DEFAULT_MAX_CACHE_BYTES) {
    this.ttlMs = Math.max(1e3, ttlMs);
    this.maxEntries = Math.max(1, maxEntries);
    this.maxBytes = Math.max(DEFAULT_ENTRY_SIZE_BYTES, maxBytes);
    this.nextCleanupAt = Date.now() + Math.min(this.ttlMs, CLEANUP_INTERVAL_MS2);
  }
  /**
   * Returns a cached response clone for a given service/token key.
   * Amortized O(1).
   */
  get(service, token) {
    const now = Date.now();
    this.maybeCleanup(now);
    const key = buildCacheKey(service, token);
    const node = this.nodesByKey.get(key);
    if (!node) {
      return null;
    }
    if (node.entry.expiresAt <= now) {
      this.removeNode(node);
      return null;
    }
    this.moveToHead(node);
    return node.entry.response.clone();
  }
  /**
   * Stores only HTTP 200 responses in cache.
   * O(1) insertion + O(k) evictions where k is number of evicted entries.
   */
  set(service, token, response) {
    if (response.status !== 200) {
      return;
    }
    const now = Date.now();
    this.maybeCleanup(now);
    const key = buildCacheKey(service, token);
    const sizeBytes = estimateResponseSize(response);
    if (sizeBytes > this.maxBytes) {
      const existing2 = this.nodesByKey.get(key);
      if (existing2) {
        this.removeNode(existing2);
      }
      return;
    }
    const existing = this.nodesByKey.get(key);
    if (existing) {
      this.removeNode(existing);
    }
    const node = {
      key,
      entry: {
        expiresAt: now + this.ttlMs,
        response: response.clone(),
        sizeBytes
      },
      prev: null,
      next: null
    };
    this.insertAtHead(node);
    this.nodesByKey.set(key, node);
    this.totalBytes += sizeBytes;
    this.evictIfNeeded();
  }
  /**
   * Removes expired cache entries and enforces memory bounds.
   */
  cleanup() {
    const now = Date.now();
    let current = this.tail;
    while (current) {
      const previous = current.prev;
      if (current.entry.expiresAt <= now) {
        this.removeNode(current);
      }
      current = previous;
    }
    this.evictIfNeeded();
    this.nextCleanupAt = now + Math.min(this.ttlMs, CLEANUP_INTERVAL_MS2);
  }
  maybeCleanup(now) {
    if (now < this.nextCleanupAt) {
      return;
    }
    this.cleanup();
  }
  evictIfNeeded() {
    while (this.nodesByKey.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const node = this.tail;
      if (!node) {
        break;
      }
      this.removeNode(node);
    }
  }
  insertAtHead(node) {
    node.prev = null;
    node.next = this.head;
    if (this.head) {
      this.head.prev = node;
    }
    this.head = node;
    if (!this.tail) {
      this.tail = node;
    }
  }
  moveToHead(node) {
    if (this.head === node) {
      return;
    }
    this.detach(node);
    this.insertAtHead(node);
  }
  removeNode(node) {
    this.detach(node);
    this.nodesByKey.delete(node.key);
    this.totalBytes = Math.max(0, this.totalBytes - node.entry.sizeBytes);
  }
  detach(node) {
    const previous = node.prev;
    const next = node.next;
    if (previous) {
      previous.next = next;
    } else {
      this.head = next;
    }
    if (next) {
      next.prev = previous;
    } else {
      this.tail = previous;
    }
    node.prev = null;
    node.next = null;
  }
};

// src/subscription/transform.ts
var PLAIN_URL_REGEX = /https?:\/\/[^\s"'<>]+/g;
var ESCAPED_URL_REGEX = /https?:\\\/\\\/[^\s"'<>]+/g;
var BASE64_TEXT_REGEX = /^[A-Za-z0-9+/_=\r\n-]+$/;
var MIN_BASE64_TEXT_LENGTH = 16;
function normalizeTargetPath(path) {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized.length > 0 ? normalized : "/sub";
}
function buildDomainPreservationContext(target, token) {
  const parsed = new URL(target.url);
  parsed.port = String(target.port);
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return {
    token,
    targetOrigin: `${parsed.protocol}//${parsed.host}`,
    targetPathPrefix: normalizeTargetPath(target.path)
  };
}
function shouldRewriteSubscriptionUrl(parsedUrl, context) {
  const origin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  if (origin === context.targetOrigin) {
    return false;
  }
  const rawToken = context.token;
  const encodedToken = encodeURIComponent(context.token);
  const hasToken = parsedUrl.pathname.includes(rawToken) || parsedUrl.pathname.includes(encodedToken) || parsedUrl.search.includes(rawToken) || parsedUrl.search.includes(encodedToken);
  if (!hasToken) {
    return false;
  }
  return parsedUrl.pathname.startsWith(`${context.targetPathPrefix}/`) || parsedUrl.pathname === context.targetPathPrefix || parsedUrl.pathname.includes("/sub/");
}
function rewriteSubscriptionUrl(rawUrl, context) {
  try {
    const parsedUrl = new URL(rawUrl);
    if (!shouldRewriteSubscriptionUrl(parsedUrl, context)) {
      return rawUrl;
    }
    return `${context.targetOrigin}${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
  } catch {
    return rawUrl;
  }
}
function rewriteTextPayload(input, context) {
  const plainRewritten = input.replace(PLAIN_URL_REGEX, (rawUrl) => rewriteSubscriptionUrl(rawUrl, context));
  return plainRewritten.replace(ESCAPED_URL_REGEX, (escapedUrl) => {
    const unescaped = escapedUrl.replace(/\\\//g, "/");
    const rewritten = rewriteSubscriptionUrl(unescaped, context);
    if (rewritten === unescaped) {
      return escapedUrl;
    }
    return rewritten.replace(/\//g, "\\/");
  });
}
function normalizeBase64Input(value) {
  return value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
}
function tryDecodeBase64Text(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("://") || !BASE64_TEXT_REGEX.test(trimmed)) {
    return null;
  }
  const normalized = normalizeBase64Input(trimmed);
  if (normalized.length < MIN_BASE64_TEXT_LENGTH) {
    return null;
  }
  const paddingNeeded = (4 - normalized.length % 4) % 4;
  const padded = normalized + "=".repeat(paddingNeeded);
  try {
    return atob(padded);
  } catch {
    return null;
  }
}
function encodeBase64Text(value, useUrlSafe, keepPadding) {
  try {
    let encoded = btoa(value);
    if (useUrlSafe) {
      encoded = encoded.replace(/\+/g, "-").replace(/\//g, "_");
    }
    if (!keepPadding) {
      encoded = encoded.replace(/=+$/g, "");
    }
    return encoded;
  } catch {
    return null;
  }
}
function isLikelyTextPayload(payload, contentType) {
  const normalizedType = contentType?.toLowerCase() ?? "";
  if (normalizedType.includes("text/") || normalizedType.includes("json") || normalizedType.includes("xml") || normalizedType.includes("yaml") || normalizedType.includes("application/octet-stream")) {
    return true;
  }
  if (payload.byteLength === 0) {
    return false;
  }
  const sampleSize = Math.min(payload.byteLength, 512);
  let printableBytes = 0;
  for (let index = 0; index < sampleSize; index += 1) {
    const value = payload[index] ?? 0;
    if (value === 9 || value === 10 || value === 13 || value >= 32 && value <= 126) {
      printableBytes += 1;
    }
  }
  return printableBytes / sampleSize >= 0.85;
}
function preserveSubscriptionDomain(payload, contentType, context) {
  if (!isLikelyTextPayload(payload, contentType)) {
    return payload;
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const textPayload = decoder.decode(payload);
  const rewrittenText = rewriteTextPayload(textPayload, context);
  if (rewrittenText !== textPayload) {
    return encoder.encode(rewrittenText);
  }
  const decodedBase64 = tryDecodeBase64Text(textPayload);
  if (!decodedBase64) {
    return payload;
  }
  const rewrittenBase64Body = rewriteTextPayload(decodedBase64, context);
  if (rewrittenBase64Body === decodedBase64) {
    return payload;
  }
  const normalizedBase64 = normalizeBase64Input(textPayload.trim());
  const useUrlSafe = /[-_]/.test(textPayload);
  const keepPadding = /=/.test(normalizedBase64);
  const reencoded = encodeBase64Text(rewrittenBase64Body, useUrlSafe, keepPadding);
  if (!reencoded) {
    return payload;
  }
  return encoder.encode(reencoded);
}

// src/subscription/proxy.ts
var DEFAULT_SUBSCRIPTION_SERVICE = "default";
var SUBSCRIPTION_TIMEOUT_MS = 1e4;
var MAX_RESPONSE_SIZE_BYTES = 10 * 1024 * 1024;
var MAX_SIZE_ERROR_CODE = "SUBSCRIPTION_SIZE_LIMIT_EXCEEDED";
var INITIAL_READ_BUFFER_BYTES = 16 * 1024;
function normalizeServiceName(value) {
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : DEFAULT_SUBSCRIPTION_SERVICE;
}
function normalizeToken(value) {
  return value.trim();
}
function isValidServiceSegment(segment) {
  return segment.length > 0 && !segment.includes("/");
}
function isValidToken(value) {
  return value.length > 0;
}
function decodePathSegment2(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
function parseSubscriptionRoute(pathname) {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length >= 2 && segments[0]?.toLowerCase() === "sub") {
    const token = normalizeToken(segments.slice(1).map(decodePathSegment2).join("/"));
    if (!isValidToken(token)) {
      return null;
    }
    return {
      service: DEFAULT_SUBSCRIPTION_SERVICE,
      token
    };
  }
  if (segments.length >= 3 && segments[1]?.toLowerCase() === "sub") {
    const rawService = segments[0] ?? "";
    const service = normalizeServiceName(decodePathSegment2(rawService));
    const token = normalizeToken(segments.slice(2).map(decodePathSegment2).join("/"));
    if (!isValidServiceSegment(service) || !isValidToken(token)) {
      return null;
    }
    return { service, token };
  }
  return null;
}
function resolveSubscriptionTarget(service, targets) {
  if (targets.length === 0) {
    return null;
  }
  const normalizedService = normalizeServiceName(service);
  for (const target of targets) {
    if (target.name.toLowerCase() === normalizedService) {
      return target;
    }
  }
  return targets[0] ?? null;
}
function buildSubscriptionBackendUrl(target, token, originalUrl) {
  const url = new URL(target.url);
  url.port = String(target.port);
  const normalizedBasePath = target.path.endsWith("/") ? target.path.slice(0, -1) : target.path;
  url.pathname = `${normalizedBasePath}/${encodeURIComponent(token)}`;
  url.search = originalUrl.search;
  return url;
}
function textResponse2(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}
function cloneHeadersForClient(headers) {
  const cloned = new Headers(headers);
  cloned.delete("content-encoding");
  cloned.delete("content-length");
  return cloned;
}
function toMaxSizeError() {
  const error = new Error("Subscription response exceeded size limit.");
  error.name = MAX_SIZE_ERROR_CODE;
  return error;
}
function isMaxSizeError(error) {
  return error instanceof Error && error.name === MAX_SIZE_ERROR_CODE;
}
function parseContentLength2(headerValue) {
  if (!headerValue) {
    return null;
  }
  const parsed = Number(headerValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}
async function readResponseBodyWithLimit(response, maxBytes) {
  const contentLength = parseContentLength2(response.headers.get("content-length"));
  if (contentLength !== null && contentLength > maxBytes) {
    throw toMaxSizeError();
  }
  if (contentLength === 0) {
    return new Uint8Array(0);
  }
  if (!response.body) {
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  let buffer = new Uint8Array(
    Math.max(
      1,
      Math.min(maxBytes, contentLength ?? INITIAL_READ_BUFFER_BYTES)
    )
  );
  let totalLength = 0;
  let done = false;
  try {
    while (!done) {
      const readResult = await reader.read();
      if (readResult.done) {
        done = true;
        continue;
      }
      const chunk = readResult.value;
      totalLength += chunk.byteLength;
      if (totalLength > maxBytes) {
        await reader.cancel();
        throw toMaxSizeError();
      }
      const required = totalLength;
      if (required > buffer.byteLength) {
        let nextCapacity = buffer.byteLength;
        while (nextCapacity < required && nextCapacity < maxBytes) {
          nextCapacity = Math.min(maxBytes, nextCapacity * 2);
        }
        if (nextCapacity < required) {
          await reader.cancel();
          throw toMaxSizeError();
        }
        const nextBuffer = new Uint8Array(nextCapacity);
        nextBuffer.set(buffer.subarray(0, totalLength - chunk.byteLength));
        buffer = nextBuffer;
      }
      buffer.set(chunk, totalLength - chunk.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  return totalLength === buffer.byteLength ? buffer : buffer.slice(0, totalLength);
}
function toResponseBody(payload) {
  const buffer = payload.buffer;
  if (buffer instanceof ArrayBuffer) {
    if (payload.byteOffset === 0 && payload.byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }
  const copied = new Uint8Array(payload.byteLength);
  copied.set(payload);
  return copied.buffer;
}
async function proxySubscriptionRequest(request, route, targets, options = {}) {
  const target = resolveSubscriptionTarget(route.service, targets);
  if (!target) {
    return {
      service: route.service,
      token: route.token,
      response: textResponse2(503, "No subscription target configured.")
    };
  }
  const requestUrl = new URL(request.url);
  const backendUrl = buildSubscriptionBackendUrl(target, route.token, requestUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, SUBSCRIPTION_TIMEOUT_MS);
  try {
    const upstreamResponse = await fetch(backendUrl.toString(), {
      method: "GET",
      headers,
      redirect: "follow",
      signal: controller.signal
    });
    const payload = await readResponseBodyWithLimit(upstreamResponse, MAX_RESPONSE_SIZE_BYTES);
    const processedPayload = options.preserveDomain === true && upstreamResponse.status === 200 ? preserveSubscriptionDomain(
      payload,
      upstreamResponse.headers.get("content-type"),
      buildDomainPreservationContext(target, route.token)
    ) : payload;
    const responseBody = toResponseBody(processedPayload);
    const responseHeaders = cloneHeadersForClient(upstreamResponse.headers);
    responseHeaders.set("content-length", String(processedPayload.byteLength));
    return {
      service: target.name,
      token: route.token,
      response: new Response(responseBody, {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders
      })
    };
  } catch (error) {
    if (isMaxSizeError(error)) {
      return {
        service: target.name,
        token: route.token,
        response: textResponse2(502, "Subscription response exceeded size limit.")
      };
    }
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      service: target.name,
      token: route.token,
      response: textResponse2(
        502,
        isAbort ? "Subscription upstream request timed out." : "Unable to reach subscription upstream service."
      )
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// src/subscription/index.ts
var MAX_SUBSCRIPTION_CACHES = 16;
var SUBSCRIPTION_CACHES = /* @__PURE__ */ new Map();
function textResponse3(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}
function getCache(ttlMs) {
  const normalizedTtlMs = Math.max(1e3, ttlMs);
  const cached = SUBSCRIPTION_CACHES.get(normalizedTtlMs);
  if (cached) {
    return cached;
  }
  if (SUBSCRIPTION_CACHES.size >= MAX_SUBSCRIPTION_CACHES) {
    SUBSCRIPTION_CACHES.clear();
  }
  const created = new SubscriptionCache(normalizedTtlMs);
  SUBSCRIPTION_CACHES.set(normalizedTtlMs, created);
  return created;
}
function canTransformResponse(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/plain") || contentType.includes("application/json");
}
function transformSubscriptionPayload(body, requestUrl) {
  const host = `${requestUrl.protocol}//${requestUrl.host}`;
  return body.replaceAll(/https?:\/\/[^\s"'<>]+/g, (matched) => {
    try {
      const parsed = new URL(matched);
      const source = `${parsed.protocol}//${parsed.host}`;
      if (source === host) {
        return matched;
      }
      return `${host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return matched;
    }
  });
}
async function maybeTransformSubscriptionResponse(response, requestUrl, enabled) {
  if (!enabled || response.status !== 200 || !canTransformResponse(response)) {
    return response;
  }
  try {
    const bodyText = await response.text();
    const transformed = transformSubscriptionPayload(bodyText, requestUrl);
    const headers = new Headers(response.headers);
    headers.set("content-length", String(new TextEncoder().encode(transformed).byteLength));
    return new Response(transformed, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch {
    return response;
  }
}
function renderSubscriptionInfoPage(env, preResolvedConfig) {
  const config = preResolvedConfig ?? resolveSubscriptionConfig(env);
  if (!config.enabled) {
    return textResponse3(404, "Subscription mode is disabled.");
  }
  const lines = [
    "cf-xray-proxy subscription mode",
    `targets: ${config.targets.length}`,
    "",
    "routes:",
    "/sub/:token",
    "/:service/sub/:token"
  ];
  for (const target of config.targets) {
    lines.push(`- ${target.name}: ${target.url}:${target.port}${target.path}`);
  }
  return textResponse3(200, lines.join("\n"));
}
async function handleSubscriptionRequest(request, env, preResolvedConfig, preParsedRoute) {
  const config = preResolvedConfig ?? resolveSubscriptionConfig(env);
  if (!config.enabled) {
    return textResponse3(404, "Not found.");
  }
  if (request.method.toUpperCase() !== "GET") {
    return textResponse3(405, "Method not allowed.");
  }
  const route = preParsedRoute ?? parseSubscriptionRoute(new URL(request.url).pathname);
  if (!route) {
    return textResponse3(404, "Not found.");
  }
  const transformEnabled = resolveSubscriptionTransform(env);
  const cache = getCache(resolveSubscriptionCacheTtlMs(env));
  const cacheService = route.service || DEFAULT_SUBSCRIPTION_SERVICE;
  const cached = cache.get(cacheService, route.token);
  if (cached) {
    return maybeTransformSubscriptionResponse(cached, new URL(request.url), transformEnabled);
  }
  const proxied = await proxySubscriptionRequest(request, route, config.targets, {
    preserveDomain: config.preserveDomain
  });
  const response = await maybeTransformSubscriptionResponse(
    proxied.response,
    new URL(request.url),
    transformEnabled
  );
  if (response.status === 200) {
    cache.set(cacheService, route.token, response);
  }
  return response;
}

// src/index.ts
var HANDLERS = {
  xhttp: handleUpgrade3,
  httpupgrade: handleUpgrade,
  ws: handleUpgrade2
};
var MAX_ENV_CACHE_ENTRIES = 32;
var BACKEND_MANAGERS = /* @__PURE__ */ new Map();
var RATE_LIMITERS = /* @__PURE__ */ new Map();
var UUID_CONNECTION_MANAGERS = /* @__PURE__ */ new Map();
var RATE_LIMIT_CONFIGS = /* @__PURE__ */ new Map();
var SUBSCRIPTION_CONFIGS = /* @__PURE__ */ new Map();
var UUID_MAX_CONNECTIONS_CACHE = /* @__PURE__ */ new Map();
function isDebugEnabled4(env) {
  return env.DEBUG === "true";
}
function shouldHideBackendUrls(env) {
  const configured = env.HIDE_BACKEND_URLS?.trim().toLowerCase();
  if (!configured) {
    return HIDE_BACKEND_URLS === "true";
  }
  return configured !== "false";
}
function getBackendManagerCacheKey(env) {
  const backendList = env.BACKEND_LIST?.trim() ?? "";
  const backendUrl = env.BACKEND_URL?.trim() ?? "";
  const healthInterval = env.BACKEND_HEALTH_CHECK_INTERVAL?.trim() ?? "";
  const stickySession = env.BACKEND_STICKY_SESSION?.trim() ?? "";
  const debug = env.DEBUG?.trim() ?? "";
  return `${backendList}::${backendUrl}::${healthInterval}::${stickySession}::${debug}`;
}
function pruneSmallCache(cache) {
  if (cache.size < MAX_ENV_CACHE_ENTRIES) {
    return;
  }
  cache.clear();
}
function getBackendManager(env) {
  const cacheKey = getBackendManagerCacheKey(env);
  const cached = BACKEND_MANAGERS.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneSmallCache(BACKEND_MANAGERS);
  const manager = new BackendManager(env);
  BACKEND_MANAGERS.set(cacheKey, manager);
  return manager;
}
function getRateLimiterCacheKey(maxConnPerIp, maxConnPerMin) {
  return `${maxConnPerIp}:${maxConnPerMin}`;
}
function getRateLimiter(maxConnPerIp, maxConnPerMin) {
  const cacheKey = getRateLimiterCacheKey(maxConnPerIp, maxConnPerMin);
  const cached = RATE_LIMITERS.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneSmallCache(RATE_LIMITERS);
  const limiter = new ConnectionRateLimiter(maxConnPerIp, maxConnPerMin);
  RATE_LIMITERS.set(cacheKey, limiter);
  return limiter;
}
function getUuidManagerCacheKey(maxConnections, debugEnabled) {
  return `${maxConnections}:${debugEnabled ? "debug" : "nodebug"}`;
}
function getUuidManager(maxConnections, debugEnabled) {
  const cacheKey = getUuidManagerCacheKey(maxConnections, debugEnabled);
  const cached = UUID_CONNECTION_MANAGERS.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneSmallCache(UUID_CONNECTION_MANAGERS);
  const manager = new UUIDConnectionManager(maxConnections, debugEnabled);
  UUID_CONNECTION_MANAGERS.set(cacheKey, manager);
  return manager;
}
function getRateLimitConfigCacheKey(env) {
  const enabled = env.RATE_LIMIT_ENABLED?.trim() ?? "";
  const perIp = env.RATE_LIMIT_MAX_CONN_PER_IP?.trim() ?? "";
  const perMinute = env.RATE_LIMIT_MAX_CONN_PER_MIN?.trim() ?? "";
  return `${enabled}:${perIp}:${perMinute}`;
}
function getRateLimitConfig(env) {
  const cacheKey = getRateLimitConfigCacheKey(env);
  const cached = RATE_LIMIT_CONFIGS.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneSmallCache(RATE_LIMIT_CONFIGS);
  const parsed = resolveRateLimitConfig(env);
  RATE_LIMIT_CONFIGS.set(cacheKey, parsed);
  return parsed;
}
function getSubscriptionConfigCacheKey(env) {
  const enabled = env.SUBSCRIPTION_ENABLED?.trim() ?? "";
  const targets = env.SUBSCRIPTION_TARGETS?.trim() ?? "";
  const preserveDomain = env.SUBSCRIPTION_PRESERVE_DOMAIN?.trim() ?? "";
  return `${enabled}:${preserveDomain}:${targets}`;
}
function getSubscriptionConfig(env) {
  const cacheKey = getSubscriptionConfigCacheKey(env);
  const cached = SUBSCRIPTION_CONFIGS.get(cacheKey);
  if (cached) {
    return cached;
  }
  pruneSmallCache(SUBSCRIPTION_CONFIGS);
  const parsed = resolveSubscriptionConfig(env);
  SUBSCRIPTION_CONFIGS.set(cacheKey, parsed);
  return parsed;
}
function getUuidMaxConnections(env) {
  const cacheKey = env.UUID_MAX_CONNECTIONS?.trim() ?? "";
  const cached = UUID_MAX_CONNECTIONS_CACHE.get(cacheKey);
  if (cached !== void 0) {
    return cached;
  }
  pruneSmallCache(UUID_MAX_CONNECTIONS_CACHE);
  const parsed = resolveUuidMaxConnections(env);
  UUID_MAX_CONNECTIONS_CACHE.set(cacheKey, parsed);
  return parsed;
}
function resolveClientIp(request) {
  const cfConnectingIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }
  const xForwardedFor = request.headers.get("x-forwarded-for");
  if (xForwardedFor) {
    const first = xForwardedFor.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  const xRealIp = request.headers.get("x-real-ip")?.trim();
  if (xRealIp) {
    return xRealIp;
  }
  return "unknown";
}
function createConnectionId() {
  if ("randomUUID" in crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function isTransportType(value) {
  return SUPPORTED_TRANSPORTS.includes(value);
}
function getDefaultTransport(env) {
  const configured = (env.TRANSPORT ?? "").toLowerCase();
  if (isTransportType(configured)) {
    return configured;
  }
  return DEFAULT_TRANSPORT;
}
function resolveTransport(request, requestUrl, env, pathTransport) {
  const fromQuery = (requestUrl.searchParams.get("transport") ?? "").toLowerCase();
  const fromHeader = (request.headers.get("x-transport-type") ?? "").toLowerCase();
  if (isTransportType(fromQuery)) {
    return fromQuery;
  }
  if (isTransportType(fromHeader)) {
    return fromHeader;
  }
  if (pathTransport) {
    return pathTransport;
  }
  return getDefaultTransport(env);
}
function rewritePath(request, path) {
  const rewritten = new URL(request.url);
  rewritten.pathname = path;
  return buildForwardRequest(request, rewritten.toString(), request.headers);
}
function parsePathTransport(pathname) {
  for (const transport of SUPPORTED_TRANSPORTS) {
    const prefix = `/${transport}`;
    if (pathname === prefix) {
      return { transport, forwardedPath: "/" };
    }
    if (pathname.startsWith(`${prefix}/`)) {
      return { transport, forwardedPath: pathname.slice(prefix.length) };
    }
  }
  return { transport: null, forwardedPath: pathname };
}
function toForwardedRequest(request, finalTransport, pathTransport, forwardedPath, originalPath) {
  if (pathTransport && pathTransport === finalTransport && forwardedPath !== originalPath) {
    return rewritePath(request, forwardedPath);
  }
  return request;
}
function stripRoutingSelectors(request) {
  const hasTransportHeader = request.headers.has("x-transport-type");
  const maybeTransportQuery = request.url.includes("transport=");
  if (!hasTransportHeader && !maybeTransportQuery) {
    return request;
  }
  let url = request.url;
  let headers = request.headers;
  let changed = false;
  if (maybeTransportQuery) {
    const parsed = new URL(request.url);
    if (parsed.searchParams.has("transport")) {
      parsed.searchParams.delete("transport");
      changed = true;
    }
    url = parsed.toString();
  }
  if (hasTransportHeader) {
    headers = new Headers(request.headers);
    headers.delete("x-transport-type");
    changed = true;
  }
  if (!changed) {
    return request;
  }
  return buildForwardRequest(request, url, headers);
}
function textResponse4(status, message) {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    }
  });
}
function rateLimitResponse(retryAfterSeconds) {
  return new Response("Too many connection attempts. Please retry later.", {
    status: 429,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "retry-after": String(Math.max(1, retryAfterSeconds))
    }
  });
}
function uuidLimitResponse() {
  return new Response("UUID connection limit reached.", {
    status: 403,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "x-websocket-close-code": String(UUID_REPLACED_CLOSE_CODE)
    }
  });
}
function isUpgradeRequest(request) {
  const upgrade = request.headers.get("upgrade");
  const connection = request.headers.get("connection")?.toLowerCase() ?? "";
  return Boolean(upgrade) && connection.includes("upgrade");
}
function isLandingPageRequest(request, pathname) {
  if (request.method.toUpperCase() !== "GET") {
    return false;
  }
  if (pathname !== "/" && pathname !== "/index.html") {
    return false;
  }
  if (isUpgradeRequest(request)) {
    return false;
  }
  const accept = request.headers.get("accept") ?? "";
  const isDocument = (request.headers.get("sec-fetch-dest") ?? "").toLowerCase() === "document";
  return isDocument || accept.includes("text/html");
}
function isHealthEndpoint(request, pathname) {
  return request.method.toUpperCase() === "GET" && pathname === "/health";
}
function isStatusEndpoint(request, pathname) {
  return request.method.toUpperCase() === "GET" && pathname === "/status";
}
function buildHealthResponse(env) {
  const backendStates = getBackendManager(env).getStates();
  const totalBackends = backendStates.length;
  const healthyBackends = backendStates.filter((backend) => backend.healthy).length;
  const status = healthyBackends > 0 ? "ok" : "degraded";
  if (!shouldHideBackendUrls(env)) {
    return jsonResponse(200, {
      status,
      timestamp: Date.now(),
      totalBackends,
      healthyBackends,
      backends: backendStates
    });
  }
  return jsonResponse(200, {
    status,
    timestamp: Date.now(),
    totalBackends,
    healthyBackends,
    unhealthyBackends: Math.max(0, totalBackends - healthyBackends)
  });
}
function buildStatusResponse(env) {
  const backendStates = getBackendManager(env).getStates();
  const healthyBackends = backendStates.filter((backend) => backend.healthy).length;
  const rateLimitConfig = getRateLimitConfig(env);
  const uuidMaxConnections = getUuidMaxConnections(env);
  const subscriptionConfig = getSubscriptionConfig(env);
  return jsonResponse(200, {
    debug: isDebugEnabled4(env),
    timestamp: Date.now(),
    transportDefault: getDefaultTransport(env),
    backends: {
      total: backendStates.length,
      healthy: healthyBackends,
      unhealthy: Math.max(0, backendStates.length - healthyBackends)
    },
    rateLimit: rateLimitConfig,
    uuidLimit: {
      enabled: uuidMaxConnections > 0,
      maxConnections: uuidMaxConnections
    },
    subscription: {
      enabled: subscriptionConfig.enabled,
      targets: subscriptionConfig.targets.map((target) => target.name)
    }
  });
}
function buildForwardRequest(request, url, headers) {
  const method = request.method.toUpperCase();
  const init = {
    method,
    headers,
    redirect: "manual"
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(url, init);
}
async function handleWithBackendFailover(request, env, transport, handler, debugEnabled, onConnectionClosed, onConnectionReady) {
  const backendManager = getBackendManager(env);
  const maxAttempts = resolveMaxRetryAttempts(env);
  const attemptedBackendUrls = [];
  let lastFailureResponse = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let failureResponseForAttempt = null;
    const selectedBackend = backendManager.getBackend(attemptedBackendUrls);
    const backendUrlString = selectedBackend.url.toString();
    attemptedBackendUrls.push(backendUrlString);
    if (debugEnabled) {
      console.log("[cf-xray-proxy]", "selected backend", {
        transport,
        backendUrl: backendUrlString,
        attempt,
        maxAttempts,
        healthy: selectedBackend.healthy,
        failures: selectedBackend.failures
      });
    }
    try {
      const response = await handler(request, env, selectedBackend.url, onConnectionClosed, onConnectionReady);
      if (!isBackendFailureResponse(response)) {
        backendManager.markHealthy(selectedBackend.url);
        return stripBackendFailureMarker(response);
      }
      backendManager.markFailed(selectedBackend.url);
      lastFailureResponse = response;
      failureResponseForAttempt = response;
      if (debugEnabled) {
        console.warn("[cf-xray-proxy] backend attempt failed", {
          transport,
          backendUrl: backendUrlString,
          attempt,
          maxAttempts,
          status: response.status
        });
      }
    } catch (error) {
      backendManager.markFailed(selectedBackend.url);
      lastError = error;
      if (debugEnabled) {
        console.error("[cf-xray-proxy] backend attempt threw error", {
          transport,
          backendUrl: backendUrlString,
          attempt,
          maxAttempts,
          error
        });
      }
    }
    if (attempt < maxAttempts) {
      await failureResponseForAttempt?.body?.cancel();
      if (failureResponseForAttempt && lastFailureResponse === failureResponseForAttempt) {
        lastFailureResponse = null;
      }
      await waitForRetry(attempt - 1);
      continue;
    }
  }
  if (lastFailureResponse) {
    return stripBackendFailureMarker(lastFailureResponse);
  }
  if (debugEnabled && lastError) {
    console.error("[cf-xray-proxy] all backend attempts failed", {
      transport,
      attempts: maxAttempts,
      error: lastError
    });
  }
  return textResponse4(502, `Backend connection failed after ${maxAttempts} attempts.`);
}
var index_default = {
  async fetch(request, env) {
    const debugEnabled = isDebugEnabled4(env);
    const requestUrl = new URL(request.url);
    const subscriptionConfig = getSubscriptionConfig(env);
    if (isHealthEndpoint(request, requestUrl.pathname)) {
      return buildHealthResponse(env);
    }
    if (isStatusEndpoint(request, requestUrl.pathname)) {
      if (!debugEnabled) {
        return textResponse4(404, "Not found.");
      }
      return buildStatusResponse(env);
    }
    const subscriptionRoute = subscriptionConfig.enabled ? parseSubscriptionRoute(requestUrl.pathname) : null;
    if (subscriptionConfig.enabled && subscriptionRoute) {
      return handleSubscriptionRequest(request, env, subscriptionConfig, subscriptionRoute);
    }
    const isRootPath = requestUrl.pathname === "/" || requestUrl.pathname === "/index.html";
    if (subscriptionConfig.enabled && request.method.toUpperCase() === "GET" && isRootPath && !isUpgradeRequest(request)) {
      return renderSubscriptionInfoPage(env, subscriptionConfig);
    }
    if (isLandingPageRequest(request, requestUrl.pathname)) {
      return Response.redirect("https://www.aparat.com", 302);
    }
    const { transport: pathTransport, forwardedPath } = parsePathTransport(requestUrl.pathname);
    const transport = resolveTransport(request, requestUrl, env, pathTransport);
    const transportRoutedRequest = toForwardedRequest(
      request,
      transport,
      pathTransport,
      forwardedPath,
      requestUrl.pathname
    );
    const forwardedRequest = stripRoutingSelectors(transportRoutedRequest);
    const handler = HANDLERS[transport];
    const isUpgrade = isUpgradeRequest(forwardedRequest);
    const clientIp = isUpgrade ? resolveClientIp(forwardedRequest) : "unknown";
    const connectionId = isUpgrade ? createConnectionId() : "";
    const rateLimitConfig = getRateLimitConfig(env);
    const shouldRateLimitConnection = rateLimitConfig.enabled && isUpgrade;
    const uuidMaxConnections = getUuidMaxConnections(env);
    const uuidManager = isUpgrade && uuidMaxConnections > 0 ? getUuidManager(uuidMaxConnections, debugEnabled) : null;
    const extractedUuid = uuidManager ? extractUuidFromRequest(forwardedRequest) : null;
    const shouldLimitUuid = Boolean(uuidManager && extractedUuid);
    if (debugEnabled) {
      const forwardedPathForLog = pathTransport && pathTransport === transport && forwardedPath !== requestUrl.pathname ? forwardedPath : requestUrl.pathname;
      console.log("[cf-xray-proxy]", "routing request", {
        originalPath: requestUrl.pathname,
        forwardedPath: forwardedPathForLog,
        transport
      });
    }
    if (shouldLimitUuid && extractedUuid && uuidManager) {
      const allowed = uuidManager.checkConnectionAllowed(extractedUuid, clientIp);
      if (!allowed) {
        return uuidLimitResponse();
      }
    }
    let unregisterRateLimitConnection;
    let unregisterUuidConnection;
    const releaseTrackedConnection = () => {
      unregisterRateLimitConnection?.();
      unregisterUuidConnection?.();
    };
    if (shouldRateLimitConnection) {
      const rateLimiter = getRateLimiter(rateLimitConfig.maxConnPerIp, rateLimitConfig.maxConnPerMin);
      if (!rateLimiter.checkConnectionAllowed(clientIp)) {
        return rateLimitResponse(rateLimiter.getRetryAfterSeconds(clientIp));
      }
      rateLimiter.registerConnection(clientIp, connectionId);
      let released = false;
      unregisterRateLimitConnection = () => {
        if (released) {
          return;
        }
        released = true;
        rateLimiter.unregisterConnection(clientIp, connectionId);
      };
    }
    const onConnectionReady = shouldLimitUuid && extractedUuid && uuidManager ? (disconnect) => {
      if (unregisterUuidConnection) {
        return;
      }
      uuidManager.registerConnection(extractedUuid, clientIp, connectionId, disconnect);
      let released = false;
      unregisterUuidConnection = () => {
        if (released) {
          return;
        }
        released = true;
        uuidManager.unregisterConnection(extractedUuid, connectionId);
      };
    } : void 0;
    try {
      const response = await handleWithBackendFailover(
        forwardedRequest,
        env,
        transport,
        handler,
        debugEnabled,
        releaseTrackedConnection,
        onConnectionReady
      );
      if (response.status !== 101) {
        releaseTrackedConnection();
      }
      return response;
    } catch (error) {
      releaseTrackedConnection();
      if (debugEnabled) {
        console.error("[cf-xray-proxy] unhandled transport error", error);
      }
      return textResponse4(502, "Backend connection failed.");
    }
  }
};
export {
  index_default as default
};
