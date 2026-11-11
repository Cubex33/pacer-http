import { createAbortError, type Clock } from "./clock.js";
import type { PacerJitter, PacerOptions, RateLimitState, RetryInfo } from "../types.js";

/** Fully-resolved pacer configuration (defaults applied). */
export interface ResolvedPacerOptions {
  readonly initial: { limit: number; windowMs: number } | null;
  readonly maxConcurrent: number;
  readonly retryOn: ReadonlySet<number>;
  readonly maxRetries: number;
  readonly jitter: PacerJitter;
  readonly keyFn: (url: string, init?: RequestInit) => string;
  readonly maxWaitMs: number;
  readonly shouldPause: (s: RateLimitState) => boolean;
  readonly onStateChange: ((key: string, s: RateLimitState | null) => void) | null;
  readonly onRetry: ((info: RetryInfo) => void) | null;
}

const DEFAULT_RETRY_ON: readonly number[] = [429];
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_WAIT_MS = 15 * 60_000;
export const BACKOFF_BASE_MS = 1000;

/** Default key: the request's origin (raw string when unparseable). */
export function defaultKey(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function resolvePacerOptions(opts: PacerOptions = {}): ResolvedPacerOptions {
  return {
    initial: opts.initial ?? null,
    maxConcurrent: opts.maxConcurrent ?? Number.POSITIVE_INFINITY,
    retryOn: new Set(opts.retryOn ?? DEFAULT_RETRY_ON),
    maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    jitter: opts.jitter ?? "full",
    keyFn: opts.key ?? defaultKey,
    maxWaitMs: opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    shouldPause: opts.shouldPause ?? ((s) => s.remaining <= 1),
    onStateChange: opts.onStateChange ?? null,
    onRetry: opts.onRetry ?? null,
  };
}

/**
 * `"full"` jitter: a uniform `0 .. min(1s, wait * 10%)` added on top of a
 * wait, so synchronized clients don't stampede the server at reset time.
 */
export function jitterMs(waitMs: number, mode: PacerJitter): number {
  if (mode === "none" || waitMs <= 0) return 0;
  return Math.random() * Math.min(1000, waitMs * 0.1);
}

/** Exponential fallback backoff: 1s, 2s, 4s, … (`attempts` is 1-based). */
export function backoffMs(attempts: number): number {
  return BACKOFF_BASE_MS * 2 ** (attempts - 1);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Minimal interval implied by a set of IETF policy windows. */
function intervalFromWindows(windows: RateLimitState["windows"]): number {
  let interval = 0;
  for (const w of windows) {
    if (w.limit > 0 && w.windowSec > 0) {
      interval = Math.max(interval, (w.windowSec * 1000) / w.limit);
    }
  }
  return interval;
}

/** Serializes limiter decisions per key (the "internal mutex"). */
class Mutex {
  private tail: Promise<void> = Promise.resolve();
  run<T>(section: () => T): Promise<T> {
    const result = this.tail.then(section);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Counting semaphore for `maxConcurrent` (per key). */
class Semaphore {
  private taken = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(signal?: AbortSignal): Promise<void> {
    if (this.taken < this.limit) {
      this.taken++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.taken++;
        resolve();
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(createAbortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  release(): void {
    this.taken--;
    this.queue.shift()?.();
  }
}

type Decision = { kind: "dispatch" } | { kind: "wait"; waitMs: number };

/** Per-key limiter state. */
class KeyRuntime {
  readonly mutex = new Mutex();
  readonly semaphore: Semaphore;
  /** Wake handles for tasks waiting on pacing (fired on state change). */
  readonly waiters = new Set<() => void>();
  /** Last usable observed state (null while the server reports nothing). */
  observed: RateLimitState | null = null;
  /** Server-reported remaining minus requests dispatched since. `Infinity` = unknown/unlimited. */
  remaining = Number.POSITIVE_INFINITY;
  /** Expected window end, epoch ms. */
  resetAt: number | null = null;
  /** Minimum spacing between dispatches (multi-window / static `initial`). */
  minIntervalMs: number;
  lastDispatchAt: number | null = null;
  /** Reset point we already paused for once (maxWaitMs liveness guard). */
  pausedForResetAt: number | null = null;

  constructor(maxConcurrent: number, initialIntervalMs: number) {
    this.semaphore = new Semaphore(maxConcurrent);
    this.minIntervalMs = initialIntervalMs;
  }

  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }
}

/**
 * The pacing state machine. All decisions are computed synchronously under a
 * per-key mutex (no awaits inside the decision section), so concurrent
 * requests can never double-spend the last slot; waits happen outside the
 * mutex and are interrupted by new observations or AbortSignal.
 */
export class AdaptiveLimiter {
  private readonly keys = new Map<string, KeyRuntime>();

  constructor(
    readonly opts: ResolvedPacerOptions,
    private readonly clock: Clock,
  ) {}

  /** Pacing interval implied by the static `initial` fallback (0 when absent). */
  private initialIntervalMs(): number {
    const initial = this.opts.initial;
    return initial !== null && initial.limit > 0 ? initial.windowMs / initial.limit : 0;
  }

  private runtime(key: string): KeyRuntime {
    let rt = this.keys.get(key);
    if (rt === undefined) {
      rt = new KeyRuntime(this.opts.maxConcurrent, this.initialIntervalMs());
      this.keys.set(key, rt);
    }
    return rt;
  }

  /**
   * Applies a parsed observation to a key. `state === null` (no usable
   * headers) keeps the previous state and just reports via `onStateChange`.
   * Non-`requests` quota units are reported but not applied (out of scope).
   */
  observe(key: string, state: RateLimitState | null): void {
    const rt = this.runtime(key);
    this.opts.onStateChange?.(key, state);
    if (state === null) return;
    if (state.unit !== undefined && state.unit !== "requests") return;
    rt.observed = state;
    // Full resync on every observation: a grown `remaining` (new window)
    // cancels pending pauses; a shrunken one tightens them.
    rt.remaining = state.remaining >= 0 ? state.remaining : Number.POSITIVE_INFINITY;
    rt.resetAt = state.reset !== null ? state.reset.getTime() : null;
    rt.minIntervalMs = intervalFromWindows(state.windows);
    rt.pausedForResetAt = null;
    rt.notify();
  }

  /**
   * Pins a key's reset point (used for `Retry-After` precedence: per the
   * IETF draft, Retry-After wins over the RateLimit effective window).
   */
  setReset(key: string, resetAt: number): void {
    const rt = this.runtime(key);
    rt.resetAt = resetAt;
    rt.pausedForResetAt = null;
    rt.notify();
  }

  /**
   * Forgets everything the server has told us about a key (all keys when no
   * argument is given): the key falls back to the static `initial` pacing
   * (or free dispatching when `initial` is not configured) until fresh
   * headers arrive.
   *
   * Honest semantics:
   * - Concurrency slots of in-flight requests are preserved (resetting does
   *   not open the `maxConcurrent` floodgates).
   * - Waits already in progress are NOT interrupted: a request paused until
   *   a reset point sleeps out its pause and only then re-decides — against
   *   the cleared state, so it dispatches (or falls back to `initial`
   *   spacing). Use an `AbortSignal` to cut an ongoing pause short.
   */
  reset(key?: string): void {
    if (key === undefined) {
      for (const rt of this.keys.values()) this.clearState(rt);
    } else {
      const rt = this.keys.get(key);
      if (rt !== undefined) this.clearState(rt);
    }
  }

  private clearState(rt: KeyRuntime): void {
    rt.observed = null;
    rt.remaining = Number.POSITIVE_INFINITY;
    rt.resetAt = null;
    rt.minIntervalMs = this.initialIntervalMs();
    rt.pausedForResetAt = null;
  }

  /**
   * Snapshot of the effective state a key's next decision would use:
   * `remaining` adjusted for requests already dispatched in the current
   * window (`Infinity` while unknown/unlimited) and possibly a
   * `Retry-After`-overridden reset. `undefined` for keys never used.
   */
  getState(key: string): RateLimitState | undefined {
    const rt = this.keys.get(key);
    if (rt === undefined) return undefined;
    // Apply the same lazy roll-over `decide` would perform on the next
    // decision, so the snapshot never reports a reset the limiter itself
    // already considers passed. Idempotent and race-free (synchronous).
    this.rollIfPassed(rt, this.clock.now().getTime());
    return this.snapshot(rt);
  }

  /** Rolls a passed reset point over (budget unknown again). Idempotent. */
  private rollIfPassed(rt: KeyRuntime, now: number): void {
    if (rt.resetAt !== null && now >= rt.resetAt) {
      rt.remaining = Number.POSITIVE_INFINITY;
      rt.pausedForResetAt = null;
    }
  }

  /** Runs `fn` under pacing and concurrency limits for `key`. */
  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const rt = this.runtime(key);
    for (;;) {
      const decision = await rt.mutex.run(() => this.decide(rt));
      if (decision.kind === "dispatch") {
        return this.execute(rt, fn, signal);
      }
      await this.sleepInterruptible(
        rt,
        decision.waitMs + jitterMs(decision.waitMs, this.opts.jitter),
        signal,
      );
    }
  }

  private decide(rt: KeyRuntime): Decision {
    const now = this.clock.now().getTime();
    // The window has rolled over since the last observation: budget is
    // unknown again, so nothing blocks until fresh headers arrive.
    this.rollIfPassed(rt, now);

    const projected = rt.remaining - 1; // Infinity - 1 === Infinity
    if (projected < 0) {
      // Would overdraw the observed budget: wait for reset / state change.
      return this.pauseDecision(rt, now);
    }
    const view = this.snapshot(rt);
    if (this.opts.shouldPause(view)) {
      // Proactive pause until reset instead of catching a 429 after the fact.
      return this.pauseDecision(rt, now);
    }
    if (rt.minIntervalMs > 0 && rt.lastDispatchAt !== null) {
      const dueAt = rt.lastDispatchAt + rt.minIntervalMs;
      if (dueAt > now) {
        return { kind: "wait", waitMs: dueAt - now };
      }
    }
    return { kind: "dispatch" };
  }

  private pauseDecision(rt: KeyRuntime, now: number): Decision {
    if (rt.resetAt === null) return { kind: "dispatch" }; // no reset info → cannot pause
    const waitMs = clamp(rt.resetAt - now, 0, this.opts.maxWaitMs);
    if (waitMs <= 0) return { kind: "dispatch" }; // reset already passed
    if (rt.pausedForResetAt === rt.resetAt) {
      // Already waited (up to maxWaitMs) for this reset point; proceed for
      // liveness instead of pausing forever.
      return { kind: "dispatch" };
    }
    rt.pausedForResetAt = rt.resetAt;
    return { kind: "wait", waitMs };
  }

  /**
   * The live state view passed to `shouldPause` (and surfaced by
   * {@link AdaptiveLimiter.getState}): the observed state with `remaining`
   * reduced by requests already dispatched in this window (`Infinity`
   * while unknown/unlimited) and the current reset point. Callers roll a
   * passed reset point over first (`rollIfPassed`).
   */
  private snapshot(rt: KeyRuntime): RateLimitState {
    return {
      limit: rt.observed?.limit ?? -1,
      remaining: rt.remaining,
      reset: rt.resetAt === null ? null : new Date(rt.resetAt),
      windows: rt.observed?.windows ?? [],
    };
  }

  private async execute<T>(rt: KeyRuntime, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const now = this.clock.now().getTime();
    if (rt.remaining !== Number.POSITIVE_INFINITY) {
      rt.remaining -= 1;
    }
    rt.lastDispatchAt = now;
    try {
      await rt.semaphore.acquire(signal);
    } catch (err) {
      // Aborted while queued for a concurrency slot: give the slot back.
      if (rt.remaining !== Number.POSITIVE_INFINITY) {
        rt.remaining += 1;
      }
      throw err;
    }
    try {
      return await fn();
    } finally {
      rt.semaphore.release();
    }
  }

  private async sleepInterruptible(
    rt: KeyRuntime,
    waitMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    // `decide` only returns `wait` with waitMs > 0 (interval due dates are
    // strictly in the future; pauses to a passed reset dispatch instead),
    // so sleeping is always meaningful here.
    const handle = this.clock.sleep(waitMs, { signal });
    const wake = () => handle.cancel();
    rt.waiters.add(wake);
    try {
      await handle.promise;
    } finally {
      rt.waiters.delete(wake);
    }
  }
}
