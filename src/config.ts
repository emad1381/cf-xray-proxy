import type { TransportType } from './types';

export const BACKEND_ORIGIN = 'http://127.0.0.1:10000';
/** Backward-compatible backend URL default. */
export const BACKEND_URL = BACKEND_ORIGIN;
/** Default backend pool when BACKEND_LIST env is not provided. */
export const BACKEND_LIST: string[] = [BACKEND_ORIGIN];
/** Backend health-check cadence in milliseconds. */
export const BACKEND_HEALTH_CHECK_INTERVAL = 30_000;
/** Sticky backend priority mode. When false, weighted selection is used. */
export const BACKEND_STICKY_SESSION = false;
/** Maximum backend failover attempts per request. */
export const MAX_RETRIES = 3;
/** Enables connection-based rate limiting. */
export const RATE_LIMIT_ENABLED = false;
/** Maximum concurrent active connections per client IP. */
export const RATE_LIMIT_MAX_CONN_PER_IP = 5;
/** Maximum accepted new connections per minute per client IP. */
export const RATE_LIMIT_MAX_CONN_PER_MIN = 10;
/** 0 means disabled. */
export const UUID_MAX_CONNECTIONS = 0;
export const DEFAULT_TRANSPORT: TransportType = 'xhttp';
export const DEBUG = 'false';
export const HIDE_BACKEND_URLS = 'true';
export const DEFAULT_HEALTH_PATH = '/health';

export const SUPPORTED_TRANSPORTS = ['xhttp', 'httpupgrade', 'ws'] as const satisfies readonly TransportType[];
