/**
 * AbortError-compatible error. Prefers DOMException (available in Node >= 18
 * and browsers), falls back to a plain Error with the same name so callers
 * can rely on `err.name === "AbortError"`.
 */
export function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("This operation was aborted", "AbortError");
  }
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

export interface SleepOptions {
  signal?: AbortSignal;
}

export interface SleepHandle {
  /** Resolves after the delay, on early {@link SleepHandle.cancel}, or rejects with AbortError if the signal fires. */
  readonly promise: Promise<void>;
  /** Wake up early (resolves the promise and clears the pending timer). */
  cancel(): void;
}

/**
 * Time source used for every pacing decision and every wait. Inject a fake
 * clock in tests; the limiter never calls `new Date()` or `setTimeout`
 * directly.
 */
export interface Clock {
  now(): Date;
  sleep(ms: number, opts?: SleepOptions): SleepHandle;
}

/** Real-time clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  sleep(ms: number, opts?: SleepOptions): SleepHandle {
    const signal = opts?.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let wake: () => void = () => {};
    const promise = new Promise<void>((resolve, reject) => {
      wake = resolve;
      if (signal?.aborted) {
        settled = true;
        reject(createAbortError());
        return;
      }
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        reject(createAbortError());
      };
      timer = setTimeout(
        () => {
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        Math.max(0, ms),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return {
      promise,
      cancel: () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        wake();
      },
    };
  }
}
