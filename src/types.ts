export type TransportType = 'xhttp' | 'httpupgrade' | 'ws';

export interface Env {
  BACKEND_URL?: string;
  BACKEND_LIST?: string;
  BACKEND_HEALTH_CHECK_INTERVAL?: string;
  BACKEND_STICKY_SESSION?: string;
  MAX_RETRIES?: string;
  RATE_LIMIT_ENABLED?: string;
  RATE_LIMIT_MAX_CONN_PER_IP?: string;
  RATE_LIMIT_MAX_CONN_PER_MIN?: string;
  SUBSCRIPTION_ENABLED?: string;
  SUBSCRIPTION_PRESERVE_DOMAIN?: string;
  SUBSCRIPTION_TARGETS?: string;
  SUBSCRIPTION_TRANSFORM?: string;
  SUBSCRIPTION_CACHE_TTL_MS?: string;
  /** Raw env value, validated at runtime before use. */
  TRANSPORT?: string;
  DEBUG?: string;
  HIDE_BACKEND_URLS?: string;
  HEALTH_PATH?: string;
  UUID_MAX_CONNECTIONS?: string;
}

/**
 * Tracks backend health metadata for routing and observability logic.
 */
export interface BackendState {
  url: string;
  healthy: boolean;
  lastCheckedAt: number;
  failureCount: number;
}

/**
 * Keeps per-IP counters for active and recent connection attempts.
 */
export interface RateLimitState {
  activeConnectionsByIp: Map<string, Set<string>>;
  connectionTimestampsByIp: Map<string, number[]>;
}

/**
 * Minimal UUID connection metadata used for in-memory tracking.
 */
export interface UUIDConnectionState {
  ip: string;
  timestamp: number;
}

/**
 * Maps UUID identifiers to active connection metadata sets.
 */
export type UUIDConnectionMap = Map<string, Set<UUIDConnectionState>>;

export type WebSocketPairTuple = [WebSocket, WebSocket];
