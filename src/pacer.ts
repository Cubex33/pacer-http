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
import type { PacerOptions, RateLimitState } from "./types.js";

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
  /**
   * Request URL used to evaluate a functional `tokenCost` for this call.
   * `Pacer#fetch` and the adapters fill it in automatically; for
   * `Pacer#schedule` pass it when `tokenCost` is a function. Default: `""`.
   */
  url?: string;
  /**
   * Request init passed to a functional `tokenCost`. `Pacer#fetch` and the
   * adapters fill it in automatically.
   */
  init?: RequestInit;
}

/** A signal that never fires — what `fn` receives when none was provided. */
const NO_SIGNAL: AbortSignal = new AbortController().signal;

/** Anything the built-in fetch accepts as a request target. */
export type FetchInput = Request | string | URL;

/**
 * What the retry engine needs to see of a client response: the status, a
 * case-insensitive single-value header lookup, and — for clients that
 * deliver non-2xx responses by throwing (axios with its default
 * `validateStatus`, got with `throwHttpErrors`) — the original error to
 * rethrow when the response is not retried, preserving the client's native
 * semantics.
 */
export interface ResponseView {
  /** HTTP status code. */
  status: number;
  /** Case-insensitive lookup of a single header value ("retry-after", …). */
  getHeader(name: string): string | null;
  /**
   * When set, a non-retried response is delivered by rethrowing this error
   * instead of resolving the response. Exhausted retries still throw
   * {@link PacerExhaustedError} (with the response attached).
   */
  error?: unknown;
  /**
   * Called when the engine is about to drop this response because it will
   * retry — release any resources it holds (e.g. dump undici's body stream
   * so the connection can be reused). Not called for the final response
   * (returned, rethrown, or attached to {@link PacerExhaustedError}).
   * Must not throw; the hook owns its error handling.
   */
  discard?: () => void;
}

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
    const tokenCost = this.resolveTokenCost(opts?.url, opts?.init);
    return this.limiter.run(key, () => fn(signal ?? NO_SIGNAL), signal, tokenCost);
  }

  /**
   * Resolves the request's token cost from `tokenCost` (number or function).
   * Negative, `NaN` and non-finite values collapse to `0` (token pacing
   * disabled for that request) instead of throwing. A throwing `tokenCost`
   * function propagates to the caller before any limiter state is touched.
   */
  private resolveTokenCost(url: string | undefined, init: RequestInit | undefined): number {
    const configured = this.opts.tokenCost;
    if (configured === null) return 0;
    const raw = typeof configured === "function" ? configured(url ?? "", init) : configured;
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
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
    this.observeView(bucket, { status: res.status, getHeader: (name) => res.headers.get(name) });
  }

  /** Feeds a client response view into the limiter (shared by all adapters). */
  private observeView(key: string, view: ResponseView): void {
    const now = this.clock.now();
    const state = parseRateLimitHeaders({ get: (name) => view.getHeader(name) }, now);
    this.limiter.observe(key, state);
    const retryAfterMs = parseRetryAfter(view.getHeader("retry-after"), now);
    if (retryAfterMs !== null && retryAfterMs > 0 && this.opts.retryOn.has(view.status)) {
      this.limiter.setReset(key, now.getTime() + retryAfterMs);
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
    return this.runWithRetry(
      () => fetchFn(input, init),
      (res) => ({ status: res.status, getHeader: (name) => res.headers.get(name) }),
      { key, signal: init?.signal ?? undefined, url, init },
    );
  }

  /**
   * The client-agnostic retry loop behind {@link Pacer.fetch} and every
   * adapter (`wrapAxios` / `wrapGot` / `wrapUndici`): paces `dispatch` under
   * the limiter for `key`, observes each response through `view`, and
   * retries statuses in `retryOn` up to `maxRetries` times — waiting exactly
   * `Retry-After` (+ jitter) when the server sends one, exponential
   * 1s/2s/4s… backoff (+ jitter) otherwise. Exhausted budgets throw
   * {@link PacerExhaustedError} with the client's native response attached;
   * non-retried responses resolve (or rethrow `view.error`, for clients
   * that deliver error statuses as exceptions).
   *
   * Use this to build adapters for clients we do not ship one for.
   */
  async runWithRetry<T>(
    dispatch: () => Promise<T>,
    view: (response: T) => ResponseView,
    opts?: ScheduleOptions,
  ): Promise<T> {
    const key = opts?.key ?? "default";
    const signal = opts?.signal;
    // One cost per call: every retry of the same request costs the same.
    // A throwing cost function propagates here, before any state is touched.
    const tokenCost = this.resolveTokenCost(opts?.url, opts?.init);
    let attempts = 0;
    for (;;) {
      attempts++;
      const res = await this.limiter.run(key, dispatch, signal, tokenCost);
      const v = view(res);
      this.observeView(key, v);
      if (!this.opts.retryOn.has(v.status)) {
        if (v.error !== undefined) throw v.error;
        return res;
      }
      if (attempts > this.opts.maxRetries) {
        throw new PacerExhaustedError(res, attempts);
      }
      // The response is being dropped: let the adapter release it (undici
      // bodies must be dumped for the connection to be reusable).
      v.discard?.();
      const retryAfterMs = parseRetryAfter(v.getHeader("retry-after"), this.clock.now());
      const baseWaitMs =
        retryAfterMs !== null && retryAfterMs > 0 ? retryAfterMs : backoffMs(attempts);
      // Retry waits are abortable via the clock but are NOT interrupted by
      // new observations: the wait is the server's own instruction.
      const waitMs = baseWaitMs + jitterMs(baseWaitMs, this.opts.jitter);
      // Observability hook (like onStateChange, exceptions propagate to
      // the caller and abort the fetch).
      this.opts.onRetry?.({
        key,
        status: v.status,
        attempt: attempts + 1,
        delayMs: waitMs,
        retryAfterMs,
      });
      if (waitMs > 0) await this.clock.sleep(waitMs, { signal }).promise;
    }
  }

  /**
   * Forgets everything the server has reported for a key (every key when
   * omitted): the key falls back to the static `initial` pacing until
   * fresh headers arrive.
   *
   * Pauses already in progress are NOT interrupted — a request paused until
   * a reset point sleeps out its pause and only then re-decides against the
   * cleared state (so it dispatches, or falls back to `initial` spacing);
   * abort it with an `AbortSignal` to cut it short. Concurrency slots of
   * in-flight requests are preserved.
   */
  reset(key?: string): void {
    this.limiter.reset(key);
  }

  /**
   * Snapshot of the effective state the next decision for `key` would use:
   * `remaining` adjusted for requests already dispatched in the current
   * window (`Infinity` while the server has not reported a quota), the
   * reset point (possibly overridden by `Retry-After`), and the policy
   * windows. `undefined` for keys that were never observed or scheduled.
   */
  getState(key: string): RateLimitState | undefined {
    return this.limiter.getState(key);
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
