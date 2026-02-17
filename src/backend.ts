import {
  BACKEND_HEALTH_CHECK_INTERVAL,
  BACKEND_LIST as DEFAULT_BACKEND_LIST,
  BACKEND_STICKY_SESSION as DEFAULT_BACKEND_STICKY_SESSION,
  BACKEND_URL as DEFAULT_BACKEND_URL,
  DEFAULT_HEALTH_PATH,
  MAX_RETRIES,
} from './config';
import type { BackendState, Env } from './types';
import { normalizeRetryCount } from './utils/fetch';

const DEFAULT_BACKEND_WEIGHT = 1;
const HEALTH_CHECK_TIMEOUT_MS = 4_000;
const BACKEND_FAILURE_HEADER_VALUE = '1';
const FAILURE_HYSTERESIS_COUNT = 1;
const RECOVERY_HYSTERESIS_COUNT = 2;
const ALIAS_MIN_SAMPLE_ATTEMPTS = 4;
const ALIAS_SAMPLE_ATTEMPTS_MULTIPLIER = 2;

export const BACKEND_FAILURE_HEADER = 'x-cf-xray-backend-failure';

export interface Backend {
  url: URL;
  weight: number;
  healthy: boolean;
  lastCheck: number;
  failures: number;
  latency: number;
  lastError?: string;
}

export interface BackendManagerShape {
  getBackend(excludedUrls?: readonly string[]): Backend;
  markFailed(url: URL | string): void;
  markHealthy(url: URL | string): void;
  getStates(): BackendState[];
  checkAll(): Promise<void>;
}

interface ParsedBackendConfig {
  rawUrl: string;
  weight: number;
}

interface AliasTable {
  probabilities: number[];
  aliases: number[];
  backendIndexes: number[];
}

interface BackendRuntimeState extends Backend {
  index: number;
  key: string;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }

  if (normalized === 'false') {
    return false;
  }

  return fallback;
}

function parseWeight(rawWeight: string | undefined): number {
  if (!rawWeight) {
    return DEFAULT_BACKEND_WEIGHT;
  }

  const parsedWeight = Number(rawWeight);
  if (!Number.isFinite(parsedWeight) || !Number.isInteger(parsedWeight) || parsedWeight <= 0) {
    return DEFAULT_BACKEND_WEIGHT;
  }

  return parsedWeight;
}

function parseBackendList(rawBackendList: string): ParsedBackendConfig[] {
  return rawBackendList
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [rawUrl = '', rawWeight] = entry.split('|', 2).map((part) => part.trim());
      return {
        rawUrl,
        weight: parseWeight(rawWeight),
      };
    })
    .filter((entry) => entry.rawUrl.length > 0);
}

function toBackendConfigurations(env: Env): ParsedBackendConfig[] {
  const fromBackendList = parseBackendList(env.BACKEND_LIST ?? '');
  if (fromBackendList.length > 0) {
    return fromBackendList;
  }

  const singleBackendUrl = env.BACKEND_URL?.trim();
  if (singleBackendUrl) {
    return [{ rawUrl: singleBackendUrl, weight: DEFAULT_BACKEND_WEIGHT }];
  }

  return DEFAULT_BACKEND_LIST.map((rawUrl) => ({
    rawUrl,
    weight: DEFAULT_BACKEND_WEIGHT,
  }));
}

function resolveHealthCheckIntervalMs(env: Env): number {
  const parsed = Number(env.BACKEND_HEALTH_CHECK_INTERVAL);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return BACKEND_HEALTH_CHECK_INTERVAL;
  }

  return Math.floor(parsed);
}

function resolveBackendLookupKey(url: URL | string): string | null {
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

function toResponseWithHeaders(response: Response, headers: Headers): Response {
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Builds Vose alias-table arrays for O(1) weighted random backend selection.
 * Reference: Michael D. Vose, \"A linear algorithm for generating random numbers
 * with a given distribution\" (IEEE TSE, 1991).
 */
function buildAliasTable(candidates: readonly BackendRuntimeState[]): AliasTable | null {
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
      backendIndexes: [only.index],
    };
  }

  const probabilities = new Array<number>(size).fill(0);
  const aliases = new Array<number>(size).fill(0);
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
      backendIndexes,
    };
  }

  const scaled = new Array<number>(size).fill(0);
  const small: number[] = [];
  const large: number[] = [];

  for (let i = 0; i < size; i += 1) {
    const candidate = candidates[i];
    const weight = Math.max(DEFAULT_BACKEND_WEIGHT, candidate?.weight ?? DEFAULT_BACKEND_WEIGHT);
    const normalizedWeight = (weight * size) / totalWeight;
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

    if (less === undefined || more === undefined) {
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
    if (index !== undefined) {
      probabilities[index] = 1;
      aliases[index] = index;
    }
  }

  while (small.length > 0) {
    const index = small.pop();
    if (index !== undefined) {
      probabilities[index] = 1;
      aliases[index] = index;
    }
  }

  return {
    probabilities,
    aliases,
    backendIndexes,
  };
}

function sampleAliasTable(table: AliasTable): number {
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

class MinIndexHeap {
  private readonly heap: number[] = [];
  private readonly positions = new Map<number, number>();

  public clear(): void {
    this.heap.length = 0;
    this.positions.clear();
  }

  public peek(): number | null {
    return this.heap[0] ?? null;
  }

  public insert(value: number): void {
    if (this.positions.has(value)) {
      return;
    }

    const position = this.heap.length;
    this.heap.push(value);
    this.positions.set(value, position);
    this.siftUp(position);
  }

  public remove(value: number): void {
    const position = this.positions.get(value);
    if (position === undefined) {
      return;
    }

    const lastIndex = this.heap.length - 1;
    const lastValue = this.heap[lastIndex];

    this.positions.delete(value);

    if (position === lastIndex) {
      this.heap.pop();
      return;
    }

    if (lastValue === undefined) {
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

  private siftUp(start: number): void {
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

  private siftDown(start: number): void {
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

  private swap(first: number, second: number): void {
    const firstValue = this.heap[first];
    const secondValue = this.heap[second];

    if (firstValue === undefined || secondValue === undefined) {
      return;
    }

    this.heap[first] = secondValue;
    this.heap[second] = firstValue;
    this.positions.set(firstValue, second);
    this.positions.set(secondValue, first);
  }
}

/**
 * Marks a response as a backend connectivity failure for failover handling.
 */
export function withBackendFailureMarker(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set(BACKEND_FAILURE_HEADER, BACKEND_FAILURE_HEADER_VALUE);
  return toResponseWithHeaders(response, headers);
}

/**
 * Returns true when a response represents a backend connectivity failure.
 */
export function isBackendFailureResponse(response: Response): boolean {
  return response.headers.get(BACKEND_FAILURE_HEADER) === BACKEND_FAILURE_HEADER_VALUE;
}

/**
 * Removes internal failover metadata headers before returning to clients.
 */
export function stripBackendFailureMarker(response: Response): Response {
  if (!isBackendFailureResponse(response)) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.delete(BACKEND_FAILURE_HEADER);
  return toResponseWithHeaders(response, headers);
}

/**
 * Resolves configured retry attempts, always returning at least one attempt.
 */
export function resolveMaxRetryAttempts(env: Env): number {
  const parsed = Number(env.MAX_RETRIES);
  return Math.max(1, normalizeRetryCount(parsed, MAX_RETRIES));
}

/**
 * Backend manager with:
 * - O(1) expected weighted random selection via alias method
 * - O(1) sticky selection via min-index heap of healthy backends
 * - health hysteresis: fast failure, slow recovery
 */
export class BackendManager implements BackendManagerShape {
  private readonly backends: BackendRuntimeState[];
  private readonly backendByUrl = new Map<string, BackendRuntimeState>();
  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckPath: string;
  private readonly stickySession: boolean;
  private readonly debugEnabled: boolean;

  private healthyAliasTable: AliasTable | null = null;
  private allAliasTable: AliasTable | null = null;
  private readonly healthyIndexHeap = new MinIndexHeap();

  private healthCheckInFlight = false;
  private nextHealthCheckAt = 0;

  constructor(env: Env) {
    this.debugEnabled = env.DEBUG === 'true';
    this.backends = this.initializeBackends(env);
    this.healthCheckIntervalMs = resolveHealthCheckIntervalMs(env);
    this.healthCheckPath = env.HEALTH_PATH?.trim() || DEFAULT_HEALTH_PATH;
    this.stickySession =
      this.backends.length > 1 && parseBoolean(env.BACKEND_STICKY_SESSION, DEFAULT_BACKEND_STICKY_SESSION);

    this.rebuildSelectionStructures();
    // Avoid immediate background probes during cold start.
    this.nextHealthCheckAt = Date.now() + this.healthCheckIntervalMs;
  }

  /**
   * Selects a backend using sticky-first or weighted-random strategy.
   * Selection is O(1) expected when no exclusions are provided.
   */
  public getBackend(excludedUrls: readonly string[] = []): Backend {
    this.maybeRunScheduledHealthChecks();

    const excluded = new Set<string>(
      excludedUrls
        .map((url) => resolveBackendLookupKey(url))
        .filter((url): url is string => url !== null),
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
  public markFailed(url: URL | string): void {
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
      console.warn('[backend] marked unhealthy after failure', {
        backendUrl: backend.url.toString(),
        failures: backend.failures,
      });
    }
  }

  /**
   * Marks a backend as healthy after a successful attempt.
   */
  public markHealthy(url: URL | string): void {
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
      console.info('[backend] marked healthy', {
        backendUrl: backend.url.toString(),
      });
    }
  }

  /**
   * Returns backend health snapshots for observability endpoints.
   */
  public getStates(): BackendState[] {
    return this.backends.map((backend) => ({
      url: backend.url.toString(),
      healthy: backend.healthy,
      lastCheckedAt: backend.lastCheck,
      failureCount: backend.failures,
      latency: backend.latency,
      lastError: backend.lastError,
    }));
  }

  private initializeBackends(env: Env): BackendRuntimeState[] {
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

        const backend: BackendRuntimeState = {
          index: this.backendByUrl.size,
          key,
          url: parsedUrl,
          weight: configuration.weight,
          healthy: true,
          lastCheck: now,
          failures: 0,
          consecutiveFailures: 0,
          consecutiveSuccesses: 0,
          latency: 0,
        };

        this.backendByUrl.set(key, backend);
      } catch {
        if (this.debugEnabled) {
          console.warn('[backend] skipping invalid BACKEND_LIST entry', configuration.rawUrl);
        }
      }
    }

    if (this.backendByUrl.size === 0) {
      const fallbackUrl = new URL(DEFAULT_BACKEND_URL);
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
        consecutiveSuccesses: 0,
        latency: 0,
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

  private createFallbackBackend(): Backend {
    const fallbackUrl = new URL(DEFAULT_BACKEND_URL);

    return {
      url: fallbackUrl,
      weight: DEFAULT_BACKEND_WEIGHT,
      healthy: true,
      lastCheck: Date.now(),
      failures: 0,
      latency: 0,
    };
  }

  private lookupBackend(url: URL | string): BackendRuntimeState | null {
    const lookupKey = resolveBackendLookupKey(url);
    if (!lookupKey) {
      return null;
    }

    return this.backendByUrl.get(lookupKey) ?? null;
  }

  private rebuildSelectionStructures(): void {
    this.allAliasTable = buildAliasTable(this.backends);
    this.rebuildHealthySelectionStructures();
  }

  private rebuildHealthySelectionStructures(): void {
    const healthyBackends: BackendRuntimeState[] = [];
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

  private pickHealthy(excluded: Set<string>): BackendRuntimeState | null {
    if (this.stickySession) {
      return this.pickStickyHealthy(excluded);
    }

    return this.pickFromAlias(this.healthyAliasTable, excluded);
  }

  private pickAny(excluded: Set<string>): BackendRuntimeState | null {
    if (this.stickySession) {
      return this.pickByOrder(this.backends, excluded, false);
    }

    return this.pickFromAlias(this.allAliasTable, excluded);
  }

  private pickStickyHealthy(excluded: Set<string>): BackendRuntimeState | null {
    const topHealthyIndex = this.healthyIndexHeap.peek();

    if (topHealthyIndex !== null) {
      const candidate = this.backends[topHealthyIndex];
      if (candidate && candidate.healthy && !excluded.has(candidate.key)) {
        return candidate;
      }
    }

    return this.pickByOrder(this.backends, excluded, true);
  }

  private pickByOrder(
    candidates: readonly BackendRuntimeState[],
    excluded: Set<string>,
    healthyOnly: boolean,
  ): BackendRuntimeState | null {
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

  private pickFromAlias(table: AliasTable | null, excluded: Set<string>): BackendRuntimeState | null {
    if (!table || table.backendIndexes.length === 0) {
      return null;
    }

    if (excluded.size === 0) {
      const selectedIndex = sampleAliasTable(table);
      return selectedIndex >= 0 ? this.backends[selectedIndex] ?? null : null;
    }

    const sampleAttempts = Math.max(
      ALIAS_MIN_SAMPLE_ATTEMPTS,
      table.backendIndexes.length * ALIAS_SAMPLE_ATTEMPTS_MULTIPLIER,
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

  private maybeRunScheduledHealthChecks(): void {
    const now = Date.now();

    if (this.healthCheckInFlight || now < this.nextHealthCheckAt) {
      return;
    }

    this.nextHealthCheckAt = now + this.healthCheckIntervalMs;
    void this.runHealthChecks();
  }

  public async checkAll(): Promise<void> {
    await this.runHealthChecks();
  }

  private async runHealthChecks(): Promise<void> {
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

  private async checkBackendHealth(backend: BackendRuntimeState): Promise<boolean> {
    const checkUrl = new URL(this.healthCheckPath, backend.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, HEALTH_CHECK_TIMEOUT_MS);

    const start = Date.now();
    let isHealthyResult = false;
    let errorReason: string | undefined;

    try {
      const response = await fetch(checkUrl.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'cache-control': 'no-cache',
        },
        signal: controller.signal,
      });

      isHealthyResult = response.status < 500;
      await response.body?.cancel();
    } catch (error) {
      isHealthyResult = false;
      errorReason = error instanceof Error ? error.message : 'Unknown network error';
    } finally {
      clearTimeout(timeout);
    }

    const latency = Date.now() - start;
    return this.applyHealthProbeResult(backend, isHealthyResult, latency, errorReason);
  }

  private applyHealthProbeResult(
    backend: BackendRuntimeState,
    isHealthyResult: boolean,
    latency: number,
    errorReason?: string,
  ): boolean {
    backend.lastCheck = Date.now();
    backend.latency = latency;

    if (isHealthyResult) {
      backend.consecutiveSuccesses += 1;
      backend.consecutiveFailures = 0;
      delete backend.lastError;

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
        console.info('[backend] health check recovered backend', {
          backendUrl: backend.url.toString(),
          latency,
        });
      }

      return true;
    }

    backend.consecutiveFailures += 1;
    backend.consecutiveSuccesses = 0;
    backend.failures += 1;
    if (errorReason) {
      backend.lastError = errorReason;
    }

    if (!backend.healthy || backend.consecutiveFailures < FAILURE_HYSTERESIS_COUNT) {
      return false;
    }

    backend.healthy = false;

    if (this.debugEnabled) {
      console.warn('[backend] health check marked backend unhealthy', {
        backendUrl: backend.url.toString(),
        failures: backend.failures,
        reason: errorReason,
      });
    }

    return true;
  }
}
