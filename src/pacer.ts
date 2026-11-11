import { PacerExhaustedError } from "./errors.js";
import { SystemClock, type Clock } from "./limiter/clock.js";
import {
  AdaptiveLimiter,
  backoffMs,
  jitterMs,
  resolvePacerOptions,
  type ResolvedPacerOptions,
} from "./limiter/limiter.js";
import { parseRateLimitHeaders } from "./parse/headers.js";
import { parseRetryAfter } from "./parse/retryAfter.js";
import type { PacerOptions } from "./types.js";

/** Extra knobs for a single {@link Pacer.schedule} call. */
export interface ScheduleOptions {
  /**
   * Bucket key to run under. Defaults to `"default"`: schedule-level tasks
   * share one bucket unless you pass `key` here or feed state via
   * {@link Pacer.observe}.
   */
  key?: string;
  /**
   * Aborts pacing / concurrency waits and is forwarded to `fn` (if it
   * accepts a signal) so the underlying client can cancel the request.
   */
  signal?: AbortSignal;
}

/** A signal that never fires — what `fn` receives when none was provided. */
const NO_SIGNAL: AbortSignal = new AbortController().signal;

/** Anything the built-in fetch accepts as a request target. */
export type FetchInput = Request | string | URL;

/**
 * Adaptive rate limiter for non-fetch clients, or as the building block for
 * your own retry loop. Feed responses via {@link Pacer.observe} and run
 * request callbacks under {@link Pacer.schedule}.
 *
 * For a ready-made fetch wrapper with 429 retries use {@link pacer}.
 */
export class Pacer {
  private readonly opts: ResolvedPacerOptions;
  private readonly clock: Clock;
  private readonly limiter: AdaptiveLimiter;

  constructor(opts: PacerOptions = {}) {
    this.opts = resolvePacerOptions(opts);
    this.clock = opts.clock ?? new SystemClock();
    this.limiter = new AdaptiveLimiter(this.opts, this.clock);
  }

  /**
   * Runs `fn` under pacing and concurrency limits for a key: the returned
   * promise resolves only when the limiter decides it is this request's
   * turn. `fn` receives the abort signal when it declares one.
   *
   * This method does NOT retry: retries (and their waits) live in the
   * {@link pacer} wrapper. Feed the response back with
   * {@link Pacer.observe} so later requests pace correctly.
   */
  async schedule<T>(fn: (signal: AbortSignal) => Promise<T>, opts?: ScheduleOptions): Promise<T> {
    const key = opts?.key ?? "default";
    const signal = opts?.signal;
    return this.limiter.run(key, () => fn(signal ?? NO_SIGNAL), signal);
  }

  /**
   * Feeds a response's rate-limit headers into the limiter. Call this for
   * every response when driving requests through {@link Pacer.schedule}
   * yourself.
   *
   * - Parses `RateLimit` / `RateLimit-Policy` / legacy `X-RateLimit-*`
   *   families into a normalized state; garbage or missing headers do not
   *   throw and do not update the state (`onStateChange` reports `null`).
   * - When the status is in `retryOn` and `Retry-After` is positive, the
   *   Retry-After deadline wins over the quota headers' reset point (per the
   *   IETF draft).
   *
   * `key` defaults to the pacer's keying of the response URL (origin, or
   * `"default"` when the response has no URL — e.g. a hand-crafted
   * `Response`).
   */
  observe(res: Response, key?: string): void {
    const bucket = key ?? (res.url !== "" ? this.opts.keyFn(res.url) : "default");
    const now = this.clock.now();
    const state = parseRateLimitHeaders(res.headers, now);
    this.limiter.observe(bucket, state);
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), now);
    if (retryAfterMs !== null && retryAfterMs > 0 && this.opts.retryOn.has(res.status)) {
      this.limiter.setReset(bucket, now.getTime() + retryAfterMs);
    }
  }

  /**
   * Runs one fetch through the limiter with the full retry policy:
   * responses whose status is in `retryOn` (default `429`) are retried up to
   * `maxRetries` times, waiting exactly `Retry-After` (+ jitter) when the
   * server sends one, or an exponential 1s/2s/4s… backoff (+ jitter) when it
   * does not. After the budget is spent, {@link PacerExhaustedError} is
   * thrown with the last response attached. Every pending retry is reported
   * through the `onRetry` hook, when configured.
   *
   * This is what {@link pacer} uses under the hood; it is exposed for
   * fetch-like clients (undici, electron net, wrappers) that are not
   * assignable to `typeof fetch`.
   */
  async fetch(fetchFn: typeof fetch, input: FetchInput, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = this.opts.keyFn(url, init);
    const signal = init?.signal ?? undefined;
    let attempts = 0;
    for (;;) {
      attempts++;
      const res = await this.limiter.run(key, () => fetchFn(input, init), signal);
      this.observe(res, key);
      if (!this.opts.retryOn.has(res.status)) return res;
      if (attempts > this.opts.maxRetries) {
        throw new PacerExhaustedError(res, attempts);
      }
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), this.clock.now());
      const baseWaitMs =
        retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempts);
      // Retry waits are abortable via the clock but are NOT interrupted by
      // new observations: the wait is the server's own instruction.
      const waitMs = baseWaitMs + jitterMs(baseWaitMs, this.opts.jitter);
      // Observability hook (like onStateChange, exceptions propagate to
      // the caller and abort the fetch).
      this.opts.onRetry?.({
        key,
        status: res.status,
        attempt: attempts + 1,
        delayMs: waitMs,
        retryAfterMs,
      });
      if (waitMs > 0) await this.clock.sleep(waitMs, { signal }).promise;
    }
  }
}

/**
 * Wraps a fetch function with adaptive client-side rate limiting.
 *
 * The wrapper reads `RateLimit` / `RateLimit-Policy` / legacy
 * `X-RateLimit-*` headers from every response and pauses requests until the
 * advertised reset instead of firing into a 429 wall. Responses with a
 * status in `retryOn` (default `[429]`) are retried: exactly
 * `Retry-After` + jitter when present, exponential 1s/2s/4s… backoff +
 * jitter otherwise, up to `maxRetries` times, then {@link
 * PacerExhaustedError} with the offending response attached.
 *
 * @example
 * ```ts
 * import { pacer } from "pacer-http";
 *
 * const fetch = pacer(globalThis.fetch, { maxConcurrent: 2 });
 * const res = await fetch("https://api.github.com/repos/nodejs/node");
 * ```
 */
export function pacer(fetchFn: typeof fetch, opts: PacerOptions = {}): typeof fetch {
  const engine = new Pacer(opts);
  const paced = (input: FetchInput, init?: RequestInit) => engine.fetch(fetchFn, input, init);
  return paced as typeof fetch;
}
