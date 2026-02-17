import { DEFAULT_TRANSPORT, HIDE_BACKEND_URLS, SUPPORTED_TRANSPORTS } from './config';
import {
  BackendManager,
  isBackendFailureResponse,
  resolveMaxRetryAttempts,
  stripBackendFailureMarker,
} from './backend';
import { renderLandingPage } from './landing';
import { ConnectionRateLimiter, resolveRateLimitConfig } from './ratelimit';
import { handleUpgrade as handleHttpUpgrade } from './transports/httpupgrade';
import { handleUpgrade as handleWsUpgrade } from './transports/ws';
import { handleUpgrade as handleXhttpUpgrade } from './transports/xhttp';
import {
  UUID_REPLACED_CLOSE_CODE,
  UUIDConnectionManager,
  extractUuidFromRequest,
  resolveUuidMaxConnections,
} from './uuid-manager';
import { resolveSubscriptionConfig } from './subscription/config';
import { handleSubscriptionRequest, renderSubscriptionInfoPage } from './subscription/index';
import { parseSubscriptionRoute } from './subscription/proxy';
import { waitForRetry } from './utils/fetch';
import type { Env, TransportType } from './types';

type ConnectionDisconnectFn = (code: number, reason: string) => void;
type UpgradeHandler = (
  request: Request,
  env: Env,
  backendOverride?: URL,
  onConnectionClosed?: () => void,
  onConnectionReady?: (disconnect: ConnectionDisconnectFn) => void,
) => Promise<Response>;

const HANDLERS: Record<TransportType, UpgradeHandler> = {
  xhttp: handleXhttpUpgrade,
  httpupgrade: handleHttpUpgrade,
  ws: handleWsUpgrade,
};
const MAX_ENV_CACHE_ENTRIES = 32;
const BACKEND_MANAGERS = new Map<string, BackendManager>();
const RATE_LIMITERS = new Map<string, ConnectionRateLimiter>();
const UUID_CONNECTION_MANAGERS = new Map<string, UUIDConnectionManager>();
const RATE_LIMIT_CONFIGS = new Map<string, ReturnType<typeof resolveRateLimitConfig>>();
const SUBSCRIPTION_CONFIGS = new Map<string, ReturnType<typeof resolveSubscriptionConfig>>();
const UUID_MAX_CONNECTIONS_CACHE = new Map<string, number>();

function isDebugEnabled(env: Env): boolean {
  return env.DEBUG === 'true';
}

function shouldHideBackendUrls(env: Env): boolean {
  const configured = env.HIDE_BACKEND_URLS?.trim().toLowerCase();

  if (!configured) {
    return HIDE_BACKEND_URLS === 'true';
  }

  return configured !== 'false';
}

function getBackendManagerCacheKey(env: Env): string {
  const backendList = env.BACKEND_LIST?.trim() ?? '';
  const backendUrl = env.BACKEND_URL?.trim() ?? '';
  const healthInterval = env.BACKEND_HEALTH_CHECK_INTERVAL?.trim() ?? '';
  const stickySession = env.BACKEND_STICKY_SESSION?.trim() ?? '';
  const debug = env.DEBUG?.trim() ?? '';
  return `${backendList}::${backendUrl}::${healthInterval}::${stickySession}::${debug}`;
}

function pruneSmallCache<K, V>(cache: Map<K, V>): void {
  if (cache.size < MAX_ENV_CACHE_ENTRIES) {
    return;
  }

  cache.clear();
}

function getBackendManager(env: Env): BackendManager {
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

function getRateLimiterCacheKey(maxConnPerIp: number, maxConnPerMin: number): string {
  return `${maxConnPerIp}:${maxConnPerMin}`;
}

function getRateLimiter(maxConnPerIp: number, maxConnPerMin: number): ConnectionRateLimiter {
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

function getUuidManagerCacheKey(maxConnections: number, debugEnabled: boolean): string {
  return `${maxConnections}:${debugEnabled ? 'debug' : 'nodebug'}`;
}

function getUuidManager(maxConnections: number, debugEnabled: boolean): UUIDConnectionManager {
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

function getRateLimitConfigCacheKey(env: Env): string {
  const enabled = env.RATE_LIMIT_ENABLED?.trim() ?? '';
  const perIp = env.RATE_LIMIT_MAX_CONN_PER_IP?.trim() ?? '';
  const perMinute = env.RATE_LIMIT_MAX_CONN_PER_MIN?.trim() ?? '';
  return `${enabled}:${perIp}:${perMinute}`;
}

function getRateLimitConfig(env: Env): ReturnType<typeof resolveRateLimitConfig> {
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

function getSubscriptionConfigCacheKey(env: Env): string {
  const enabled = env.SUBSCRIPTION_ENABLED?.trim() ?? '';
  const targets = env.SUBSCRIPTION_TARGETS?.trim() ?? '';
  const preserveDomain = env.SUBSCRIPTION_PRESERVE_DOMAIN?.trim() ?? '';
  return `${enabled}:${preserveDomain}:${targets}`;
}

function getSubscriptionConfig(env: Env): ReturnType<typeof resolveSubscriptionConfig> {
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

function getUuidMaxConnections(env: Env): number {
  const cacheKey = env.UUID_MAX_CONNECTIONS?.trim() ?? '';
  const cached = UUID_MAX_CONNECTIONS_CACHE.get(cacheKey);

  if (cached !== undefined) {
    return cached;
  }

  pruneSmallCache(UUID_MAX_CONNECTIONS_CACHE);
  const parsed = resolveUuidMaxConnections(env);
  UUID_MAX_CONNECTIONS_CACHE.set(cacheKey, parsed);
  return parsed;
}

function resolveClientIp(request: Request): string {
  const cfConnectingIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp) {
    return cfConnectingIp;
  }

  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }

  const xRealIp = request.headers.get('x-real-ip')?.trim();
  if (xRealIp) {
    return xRealIp;
  }

  return 'unknown';
}

function createConnectionId(): string {
  if ('randomUUID' in crypto && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isTransportType(value: string): value is TransportType {
  return (SUPPORTED_TRANSPORTS as readonly string[]).includes(value);
}

function getDefaultTransport(env: Env): TransportType {
  const configured = (env.TRANSPORT ?? '').toLowerCase();

  if (isTransportType(configured)) {
    return configured;
  }

  return DEFAULT_TRANSPORT;
}

function resolveTransport(request: Request, requestUrl: URL, env: Env, pathTransport: TransportType | null): TransportType {
  const fromQuery = (requestUrl.searchParams.get('transport') ?? '').toLowerCase();
  const fromHeader = (request.headers.get('x-transport-type') ?? '').toLowerCase();

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

function rewritePath(request: Request, path: string): Request {
  const rewritten = new URL(request.url);
  rewritten.pathname = path;

  return buildForwardRequest(request, rewritten.toString(), request.headers);
}

function parsePathTransport(pathname: string): { transport: TransportType | null; forwardedPath: string } {
  for (const transport of SUPPORTED_TRANSPORTS) {
    const prefix = `/${transport}`;

    if (pathname === prefix) {
      return { transport, forwardedPath: '/' };
    }

    if (pathname.startsWith(`${prefix}/`)) {
      return { transport, forwardedPath: pathname.slice(prefix.length) };
    }
  }

  return { transport: null, forwardedPath: pathname };
}

function toForwardedRequest(
  request: Request,
  finalTransport: TransportType,
  pathTransport: TransportType | null,
  forwardedPath: string,
  originalPath: string,
): Request {
  // Only strip /{transport} prefix when that prefix is actually selected as transport.
  if (pathTransport && pathTransport === finalTransport && forwardedPath !== originalPath) {
    return rewritePath(request, forwardedPath);
  }

  return request;
}

function stripRoutingSelectors(request: Request): Request {
  const hasTransportHeader = request.headers.has('x-transport-type');
  const maybeTransportQuery = request.url.includes('transport=');

  if (!hasTransportHeader && !maybeTransportQuery) {
    return request;
  }

  let url = request.url;
  let headers: HeadersInit = request.headers;
  let changed = false;

  if (maybeTransportQuery) {
    const parsed = new URL(request.url);

    if (parsed.searchParams.has('transport')) {
      // transport is a Worker-side selector and should not be passed to backend.
      parsed.searchParams.delete('transport');
      changed = true;
    }

    url = parsed.toString();
  }

  if (hasTransportHeader) {
    headers = new Headers(request.headers);
    headers.delete('x-transport-type');
    changed = true;
  }

  if (!changed) {
    return request;
  }

  return buildForwardRequest(request, url, headers);
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function rateLimitResponse(retryAfterSeconds: number): Response {
  return new Response('Too many connection attempts. Please retry later.', {
    status: 429,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'retry-after': String(Math.max(1, retryAfterSeconds)),
    },
  });
}

function uuidLimitResponse(): Response {
  return new Response('UUID connection limit reached.', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-websocket-close-code': String(UUID_REPLACED_CLOSE_CODE),
    },
  });
}

/**
 * Determines whether the request is an HTTP upgrade handshake.
 * Requires both Upgrade and Connection: upgrade semantics.
 */
function isUpgradeRequest(request: Request): boolean {
  const upgrade = request.headers.get('upgrade');
  const connection = request.headers.get('connection')?.toLowerCase() ?? '';
  return Boolean(upgrade) && connection.includes('upgrade');
}

function isLandingPageRequest(request: Request, pathname: string): boolean {
  if (request.method.toUpperCase() !== 'GET') {
    return false;
  }

  if (pathname !== '/' && pathname !== '/index.html') {
    return false;
  }

  if (isUpgradeRequest(request)) {
    return false;
  }

  const accept = request.headers.get('accept') ?? '';
  const isDocument = (request.headers.get('sec-fetch-dest') ?? '').toLowerCase() === 'document';
  return isDocument || accept.includes('text/html');
}

function isHealthEndpoint(request: Request, pathname: string): boolean {
  return request.method.toUpperCase() === 'GET' && pathname === '/health';
}

function isStatusEndpoint(request: Request, pathname: string): boolean {
  return request.method.toUpperCase() === 'GET' && pathname === '/status';
}

function buildHealthResponse(env: Env): Response {
  const backendStates = getBackendManager(env).getStates();
  const totalBackends = backendStates.length;
  const healthyBackends = backendStates.filter((backend) => backend.healthy).length;
  const status = healthyBackends > 0 ? 'ok' : 'degraded';

  if (!shouldHideBackendUrls(env)) {
    return jsonResponse(200, {
      status,
      timestamp: Date.now(),
      totalBackends,
      healthyBackends,
      backends: backendStates,
    });
  }

  return jsonResponse(200, {
    status,
    timestamp: Date.now(),
    totalBackends,
    healthyBackends,
    unhealthyBackends: Math.max(0, totalBackends - healthyBackends),
  });
}

function buildStatusResponse(env: Env): Response {
  const backendStates = getBackendManager(env).getStates();
  const healthyBackends = backendStates.filter((backend) => backend.healthy).length;
  const rateLimitConfig = getRateLimitConfig(env);
  const uuidMaxConnections = getUuidMaxConnections(env);
  const subscriptionConfig = getSubscriptionConfig(env);

  return jsonResponse(200, {
    debug: isDebugEnabled(env),
    timestamp: Date.now(),
    transportDefault: getDefaultTransport(env),
    backends: {
      total: backendStates.length,
      healthy: healthyBackends,
      unhealthy: Math.max(0, backendStates.length - healthyBackends),
    },
    rateLimit: rateLimitConfig,
    uuidLimit: {
      enabled: uuidMaxConnections > 0,
      maxConnections: uuidMaxConnections,
    },
    subscription: {
      enabled: subscriptionConfig.enabled,
      targets: subscriptionConfig.targets.map((target) => target.name),
    },
  });
}

function buildForwardRequest(request: Request, url: string, headers: HeadersInit): Request {
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers,
    redirect: 'manual',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = request.body;
  }

  return new Request(url, init);
}

/**
 * Routes a request through weighted backend selection with failover retries.
 */
async function handleWithBackendFailover(
  request: Request,
  env: Env,
  transport: TransportType,
  handler: UpgradeHandler,
  debugEnabled: boolean,
  onConnectionClosed?: () => void,
  onConnectionReady?: (disconnect: ConnectionDisconnectFn) => void,
): Promise<Response> {
  const backendManager = getBackendManager(env);
  const maxAttempts = resolveMaxRetryAttempts(env);
  const attemptedBackendUrls: string[] = [];
  let lastFailureResponse: Response | null = null;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let failureResponseForAttempt: Response | null = null;
    const selectedBackend = backendManager.getBackend(attemptedBackendUrls);
    const backendUrlString = selectedBackend.url.toString();
    attemptedBackendUrls.push(backendUrlString);

    if (debugEnabled) {
      console.log('[cf-xray-proxy]', 'selected backend', {
        transport,
        backendUrl: backendUrlString,
        attempt,
        maxAttempts,
        healthy: selectedBackend.healthy,
        failures: selectedBackend.failures,
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
        console.warn('[cf-xray-proxy] backend attempt failed', {
          transport,
          backendUrl: backendUrlString,
          attempt,
          maxAttempts,
          status: response.status,
        });
      }
    } catch (error) {
      backendManager.markFailed(selectedBackend.url);
      lastError = error;

      if (debugEnabled) {
        console.error('[cf-xray-proxy] backend attempt threw error', {
          transport,
          backendUrl: backendUrlString,
          attempt,
          maxAttempts,
          error,
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
    console.error('[cf-xray-proxy] all backend attempts failed', {
      transport,
      attempts: maxAttempts,
      error: lastError,
    });
  }

  return textResponse(502, `Backend connection failed after ${maxAttempts} attempts.`);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const debugEnabled = isDebugEnabled(env);
    const requestUrl = new URL(request.url);
    const subscriptionConfig = getSubscriptionConfig(env);

    if (isHealthEndpoint(request, requestUrl.pathname)) {
      return buildHealthResponse(env);
    }

    if (isStatusEndpoint(request, requestUrl.pathname)) {
      if (!debugEnabled) {
        return textResponse(404, 'Not found.');
      }

      return buildStatusResponse(env);
    }

    const subscriptionRoute = subscriptionConfig.enabled ? parseSubscriptionRoute(requestUrl.pathname) : null;
    if (subscriptionConfig.enabled && subscriptionRoute) {
      return handleSubscriptionRequest(request, env, subscriptionConfig, subscriptionRoute);
    }

    const isRootPath = requestUrl.pathname === '/' || requestUrl.pathname === '/index.html';
    if (subscriptionConfig.enabled && request.method.toUpperCase() === 'GET' && isRootPath && !isUpgradeRequest(request)) {
      return renderSubscriptionInfoPage(env, subscriptionConfig);
    }

    if (isLandingPageRequest(request, requestUrl.pathname)) {
      return Response.redirect('https://www.aparat.com', 302);
    }

    const { transport: pathTransport, forwardedPath } = parsePathTransport(requestUrl.pathname);
    const transport = resolveTransport(request, requestUrl, env, pathTransport);
    const transportRoutedRequest = toForwardedRequest(
      request,
      transport,
      pathTransport,
      forwardedPath,
      requestUrl.pathname,
    );
    const forwardedRequest = stripRoutingSelectors(transportRoutedRequest);
    const handler = HANDLERS[transport];
    const isUpgrade = isUpgradeRequest(forwardedRequest);
    const clientIp = isUpgrade ? resolveClientIp(forwardedRequest) : 'unknown';
    const connectionId = isUpgrade ? createConnectionId() : '';

    const rateLimitConfig = getRateLimitConfig(env);
    const shouldRateLimitConnection = rateLimitConfig.enabled && isUpgrade;
    const uuidMaxConnections = getUuidMaxConnections(env);
    const uuidManager = isUpgrade && uuidMaxConnections > 0 ? getUuidManager(uuidMaxConnections, debugEnabled) : null;
    const extractedUuid = uuidManager ? extractUuidFromRequest(forwardedRequest) : null;
    const shouldLimitUuid = Boolean(uuidManager && extractedUuid);

    if (debugEnabled) {
      const forwardedPathForLog =
        pathTransport && pathTransport === transport && forwardedPath !== requestUrl.pathname
          ? forwardedPath
          : requestUrl.pathname;

      console.log('[cf-xray-proxy]', 'routing request', {
        originalPath: requestUrl.pathname,
        forwardedPath: forwardedPathForLog,
        transport,
      });
    }

    if (shouldLimitUuid && extractedUuid && uuidManager) {
      const allowed = uuidManager.checkConnectionAllowed(extractedUuid, clientIp);

      if (!allowed) {
        return uuidLimitResponse();
      }
    }

    let unregisterRateLimitConnection: (() => void) | undefined;
    let unregisterUuidConnection: (() => void) | undefined;
    const releaseTrackedConnection = (): void => {
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
      unregisterRateLimitConnection = (): void => {
        if (released) {
          return;
        }

        released = true;
        rateLimiter.unregisterConnection(clientIp, connectionId);
      };
    }

    const onConnectionReady =
      shouldLimitUuid && extractedUuid && uuidManager
        ? (disconnect: ConnectionDisconnectFn): void => {
          if (unregisterUuidConnection) {
            return;
          }

          uuidManager.registerConnection(extractedUuid, clientIp, connectionId, disconnect);

          let released = false;
          unregisterUuidConnection = (): void => {
            if (released) {
              return;
            }

            released = true;
            uuidManager.unregisterConnection(extractedUuid, connectionId);
          };
        }
        : undefined;

    try {
      const response = await handleWithBackendFailover(
        forwardedRequest,
        env,
        transport,
        handler,
        debugEnabled,
        releaseTrackedConnection,
        onConnectionReady,
      );

      if (response.status !== 101) {
        releaseTrackedConnection();
      }

      return response;
    } catch (error) {
      releaseTrackedConnection();

      if (debugEnabled) {
        console.error('[cf-xray-proxy] unhandled transport error', error);
      }

      return textResponse(502, 'Backend connection failed.');
    }
  },
};
