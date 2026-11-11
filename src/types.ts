import type { Clock } from "./limiter/clock.js";

/**
 * One quota window advertised by the server (IETF RateLimit-Policy items).
 * `limit` is the quota allocated for the window; `windowSec` is the window
 * length in seconds.
 */
export interface RateLimitWindow {
  limit: number;
  windowSec: number;
}

/**
 * Normalized rate-limit information parsed from a response's headers.
 *
 * - `limit` / `remaining` are `-1` when the server does not report them.
 * - `reset` is the absolute point in time when the quota is expected to be
 *   restored, or `null` when unknown.
 * - `windows` is populated for IETF `RateLimit-Policy` fields (possibly
 *  multiple windows, e.g. `"burst";q=10;w=1,"daily";q=1000;w=86400`) and is
 *  empty for legacy `X-RateLimit-*` headers.
 * - `unit` is the quota unit when the server reports one (e.g. `"requests"`,
 *  `"tokens"`, `"content-bytes"`). The limiter only paces `requests` states
 *  and ignores other units (token quota is out of scope, see README).
 */
export interface RateLimitState {
  limit: number;
  remaining: number;
  reset: Date | null;
  windows: RateLimitWindow[];
  unit?: string;
}

/** Jitter mode for waits (see README › Options › jitter). */
export type PacerJitter = "none" | "full";

/** Options for {@link pacer} / {@link Pacer}. All fields are optional. */
export interface PacerOptions {
  /**
   * Static fallback used while the server reports no rate-limit headers:
   * requests are paced at `windowMs / limit` apart. Once usable headers are
   * observed, the limiter switches to adaptive mode and `initial` no longer
   * applies (except for non-`requests` quota units).
   */
  initial?: { limit: number; windowMs: number };
  /**
   * Maximum number of requests in flight at the same time, counted per key
   * (origin by default). Default: `Infinity`.
   */
  maxConcurrent?: number;
  /**
   * Response status codes that trigger a retry. Default: `[429]`. Add e.g.
   * `403` for APIs that signal rate limiting with 403 + `Retry-After`.
   */
  retryOn?: number[];
  /**
   * How many times a retryable response is retried before
   * {@link PacerExhaustedError} is thrown. Default: `3`.
   */
  maxRetries?: number;
  /**
   * `"full"` (default) adds a random `0..min(1s, wait*10%)` on top of every
   * pause/retry wait to avoid thundering herds; `"none"` makes waits exact.
   */
  jitter?: PacerJitter;
  /**
   * Bucketing function: state is isolated per returned key. Receives the
   * request URL and init. Default: the URL's origin (the raw string if the
   * URL cannot be parsed).
   */
  key?: (url: string, init?: RequestInit) => string;
  /**
   * Cap for a single pause, in milliseconds. Default: 15 minutes. Pauses
   * longer than this are truncated; after one truncated pause for the same
   * reset point the request proceeds anyway (liveness over strictness).
   */
  maxWaitMs?: number;
  /**
   * Decides whether the next request should proactively pause until `reset`
   * instead of being dispatched. Receives the current state with `remaining`
   * adjusted for requests already dispatched in the current window.
   * Default: `(s) => s.remaining <= 1` — stop before consuming the last slot.
   */
  shouldPause?: (s: RateLimitState) => boolean;
  /**
   * Metrics hook: called on every observed response with the parsed state
   * for the key, or `null` when the response carried no usable rate-limit
   * headers (state is not updated in that case).
   */
  onStateChange?: (key: string, s: RateLimitState | null) => void;
  /**
   * Clock injection (testing / simulation). Default: system clock.
   */
  clock?: Clock;
}
