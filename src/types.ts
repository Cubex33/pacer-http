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
 * One token-bucket snapshot (LLM APIs: OpenAI / Anthropic TPM quotas).
 * `limit` and `remaining` are `-1` when the server does not report them;
 * `reset` is the absolute point in time when the token budget is restored,
 * or `null` when unknown.
 */
export interface TokenQuota {
  /** Token quota allocated for the window, `-1` when the server does not report it. */
  limit: number;
  /** Tokens left in the window, `-1` when the server does not report it. */
  remaining: number;
  /** Absolute point in time when the token budget is restored, or `null`. */
  reset: Date | null;
}

/**
 * Normalized rate-limit information parsed from a response's headers.
 *
 * - `limit` / `remaining` / `reset` describe the **request** dimension (the
 *   quota unit is reported separately in `unit`). `limit` and `remaining`
 *   are `-1` when the server does not report them, `reset` is `null` when
 *   unknown.
 * - `windows` is populated for IETF `RateLimit-Policy` fields (possibly
 *   multiple windows, e.g. `"burst";q=10;w=1,"daily";q=1000;w=86400`) and is
 *   empty for legacy `X-RateLimit-*` headers. Token policies are reported in
 *   `tokens` and are not mixed into `windows`.
 * - `unit` is the quota unit when the server reports one (e.g. `"requests"`,
 *   `"tokens"`, `"content-bytes"`). The limiter paces `requests` states
 *   (default when `unit` is absent), `tokens` states via the `tokens` field,
 *   and reports other units without pacing them.
 * - `tokens` carries the token dimension when the response advertises one
 *   (OpenAI/Anthropic `*-tokens-*` headers, IETF policies with
 *   `qu="tokens"`). It is present next to the request dimension when the
 *   server reports both, and also when tokens are the only dimension
 *   reported (`unit: "tokens"` in that case).
 */
export interface RateLimitState {
  limit: number;
  remaining: number;
  reset: Date | null;
  windows: RateLimitWindow[];
  unit?: string;
  tokens?: TokenQuota;
}

/** Jitter mode for waits (see README › Options › jitter). */
export type PacerJitter = "none" | "full";

/**
 * Payload for the {@link PacerOptions.onRetry} observability hook, fired
 * once right before every retry.
 */
export interface RetryInfo {
  /** Bucket key the retried request runs under. */
  key: string;
  /** Status code of the response being retried (e.g. `429`). */
  status: number;
  /** Number of the attempt that will run next (the first retry is `2`). */
  attempt: number;
  /** Actual wait before that attempt, in milliseconds, including jitter. */
  delayMs: number;
  /**
   * Parsed `Retry-After` in milliseconds as the server sent it, or `null`
   * when the response carried no (parseable) `Retry-After`. `0` means the
   * server asked for an immediate retry; the wait falls back to backoff
   * in that case, but the value is still reported here.
   */
  retryAfterMs: number | null;
}

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
   * Estimated token cost of one request, used to pace the token dimension
   * (LLM TPM quotas) in addition to requests. A number applies to every
   * request; a function receives the request URL and init and may estimate
   * from the payload (e.g. `promptTokens + maxTokens`). Negative, `NaN` and
   * non-finite results are treated as `0`. When omitted, the token
   * dimension is never paced (full backwards compatibility). Exceptions
   * thrown by the function propagate to the caller before any limiter state
   * is touched, exactly like `key`'s.
   */
  tokenCost?: number | ((url: string, init?: RequestInit) => number);
  /**
   * Decides whether the next request should proactively pause until the
   * token reset instead of being dispatched. Receives the effective token
   * snapshot: `remaining` reduced by token cost reserved for in-flight
   * requests. Default: `(q) => q.remaining <= 0` (pause once the token
   * budget is spent). Only consulted when `tokenCost` is configured.
   */
  shouldPauseTokens?: (q: TokenQuota) => boolean;
  /**
   * Metrics hook: called on every observed response with the parsed state
   * for the key, or `null` when the response carried no usable rate-limit
   * headers (state is not updated in that case).
   */
  onStateChange?: (key: string, s: RateLimitState | null) => void;
  /**
   * Retry observability hook: called exactly once right before every
   * retry (not for the initial attempt, and not when the retry budget is
   * already spent) with the bucket key, the retryable status, the
   * upcoming attempt number, the actual wait including jitter, and the
   * parsed `Retry-After` (see {@link RetryInfo}). Exceptions thrown by the
   * callback propagate to the caller, exactly like `onStateChange`'s.
   */
  onRetry?: (info: RetryInfo) => void;
  /**
   * Clock injection (testing / simulation). Default: system clock.
   */
  clock?: Clock;
}
