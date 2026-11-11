import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PacerExhaustedError } from "../../src/errors.js";
import { SystemClock } from "../../src/limiter/clock.js";
import { backoffMs, jitterMs } from "../../src/limiter/limiter.js";
import { Pacer, pacer } from "../../src/pacer.js";
import type { RateLimitState } from "../../src/types.js";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
}

interface ScriptedFetch {
  fn: (input: Request | string | URL, init?: RequestInit) => Promise<Response>;
  calls: number[];
}

/** A fetch stub serving a fixed script; records dispatch timestamps. */
function scriptedFetch(script: ScriptedResponse[]): ScriptedFetch {
  const calls: number[] = [];
  const fn = (_input: Request | string | URL, _init?: RequestInit): Promise<Response> => {
    calls.push(Date.now() - t0);
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    return Promise.resolve(
      new Response("ok", { status: next.status ?? 200, headers: next.headers ?? {} }),
    );
  };
  return { fn, calls };
}

/** GitHub-style headers; reset is `resetInMs` from "now". */
function gh(limit: number, remaining: number, resetInMs: number): Record<string, string> {
  return {
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    // ceil keeps the epoch second at or after the target instant; the real
    // gap is therefore resetInMs .. resetInMs + 999.
    "x-ratelimit-reset": String(Math.ceil((Date.now() + resetInMs) / 1000)),
  };
}

/** IETF draft-11 headers for a burst/sustained policy. */
function ietf(
  burstRemaining: number | null,
  resetInSec: number | null,
  sustainedRemaining: number | null,
  sustainedResetInSec: number | null,
): Record<string, string> {
  const ratelimit = [
    burstRemaining === null
      ? null
      : `"burst";r=${burstRemaining}${resetInSec === null ? "" : `;t=${resetInSec}`}`,
    sustainedRemaining === null
      ? null
      : `"sustained";r=${sustainedRemaining}${
          sustainedResetInSec === null ? "" : `;t=${sustainedResetInSec}`
        }`,
  ]
    .filter((x) => x !== null)
    .join(",");
  return {
    ratelimit,
    "ratelimit-policy": '"burst";q=10;w=1,"sustained";q=100;w=60',
  };
}

const URL_A = "https://api.example.com/a";
const URL_B = "https://api.example.com/b"; // same origin as URL_A
const URL_C = "https://other.example.com/c"; // a different origin

let t0: number;

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ *
 * Pacing from observed state
 * ------------------------------------------------------------------ */

describe("adaptive pacing", () => {
  it("sleeps until the advertised reset when remaining hits 0", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 3_600_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none", maxWaitMs: 4_000_000 });
    await fetch(URL_A);
    expect(calls.length).toBe(1);

    const second = fetch(URL_A);
    // Not dispatched before the reset point.
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000); // the epoch gap is ≤ 3_600_999
    await second;
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(3_600_000);
    expect(calls[1]! - calls[0]!).toBeLessThan(3_700_000);
  });

  it("by default pauses before consuming the last slot", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 1, 60_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A); // observes remaining=1

    const second = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.length).toBe(1); // default shouldPause keeps the last slot
    await vi.advanceTimersByTimeAsync(60_000); // the epoch gap is ≤ 60_999
    await second;
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(60_000);
    expect(calls[1]! - calls[0]!).toBeLessThan(61_000);
  });

  it("serializes the last-slot race: one request goes now, the other waits", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 1, 60_000) }, {}]);
    const fetch = pacer(fn, {
      jitter: "none",
      shouldPause: (s) => s.remaining <= 0, // allow consuming the last slot
    });
    await fetch(URL_A); // observes remaining=1

    const first = fetch(URL_A);
    const second = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.length).toBe(2); // exactly one took the last slot
    expect(calls[1]).toBe(calls[0]);

    await vi.advanceTimersByTimeAsync(61_000); // the epoch gap is ≤ 60_999
    await Promise.all([first, second]);
    expect(calls.length).toBe(3); // the loser went at reset
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(60_000);
    expect(calls[2]! - calls[1]!).toBeLessThan(61_000);
  });

  it("paces by the strictest IETF window (10/w=1 + 100/w=60 → ≥600ms)", async () => {
    const headers = ietf(3, 30, 87, 30);
    const { fn, calls } = scriptedFetch([{ headers }, { headers }, { headers }]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A); // observes the multi-window state

    const more = [fetch(URL_A), fetch(URL_A)];
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.all(more);
    expect(calls.length).toBe(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(600);
    expect(calls[1]! - calls[0]!).toBeLessThan(700);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(600);
  });

  it("pauses at least until reset when a window reports remaining=0 (t=1 → ≥1s)", async () => {
    const { fn, calls } = scriptedFetch([
      { headers: ietf(3, 30, 87, 30) },
      { headers: ietf(0, 1, 87, 30) }, // burst window exhausted
      {},
    ]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A); // observes the multi-window state

    const second = fetch(URL_A); // paced at 600ms by the strictest window
    await vi.advanceTimersByTimeAsync(600);
    await second; // its response exhausts the burst window

    const third = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(2); // still paused
    await vi.advanceTimersByTimeAsync(1_001);
    await third;
    expect(calls.length).toBe(3);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(1_000);
    expect(calls[2]! - calls[1]!).toBeLessThan(2_100);
  });

  it("wakes a paused request when a newer observation grows remaining", async () => {
    const p = new Pacer({ jitter: "none" });
    let dispatched = 0;
    const observe = (remaining: number) =>
      p.observe(new Response("ok", { headers: gh(10, remaining, 90_000) }), "default");

    observe(0); // exhausted
    const done = p.schedule(() => {
      dispatched++;
      return Promise.resolve(42);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatched).toBe(0); // paused for the reset

    observe(10); // new window: budget restored
    await done;
    expect(dispatched).toBe(1);
  });

  it("does not pause when the advertised reset is already in the past", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, -60_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A);
    const second = fetch(URL_A);
    await second; // resolves without advancing any timer
    expect(calls.length).toBe(2);
    expect(calls[1]).toBe(calls[0]);
  });

  it("truncates a single pause at maxWaitMs, then proceeds for liveness", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 90_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none", maxWaitMs: 5_000 });
    await fetch(URL_A);

    const second = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(5_000);
    await second; // proceeds although reset is still 85s away
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBe(5_000);
  });

  it("isolates buckets by origin", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 90_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A);

    const other = fetch(URL_C); // different origin → its own bucket
    await other; // no pause, no timers
    expect(calls.length).toBe(2);
  });

  it("buckets by a custom key function", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 90_000) }, {}]);
    const fetch = pacer(fn, {
      key: (url) => new URL(url).pathname,
      jitter: "none",
    });
    await fetch("https://api.example.com/a");

    const other = fetch("https://api.example.com/b");
    await other;
    expect(calls.length).toBe(2);
  });

  it("buckets unparseable URLs under their raw string", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 90_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch("not a url at all");

    const second = fetch("not a url at all"); // same raw key → paused
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(90_000); // the epoch gap is ≤ 90_999
    await second;
    expect(calls.length).toBe(2);

    const other = fetch("definitely not a url either"); // a different raw key
    await other;
    expect(calls.length).toBe(3);
  });
});

/* ------------------------------------------------------------------ *
 * Static initial pacing
 * ------------------------------------------------------------------ */

describe("static initial pacing", () => {
  it("spaces requests at windowMs / limit while no headers are observed", async () => {
    const p = new Pacer({ initial: { limit: 2, windowMs: 1_000 }, jitter: "none" });
    const stamps: number[] = [];
    const job = () => {
      stamps.push(Date.now() - t0);
      return Promise.resolve(stamps.length);
    };
    const results = await (async () => {
      const all = [p.schedule(job), p.schedule(job), p.schedule(job)];
      await vi.advanceTimersByTimeAsync(2_000);
      return Promise.all(all);
    })();
    expect(results).toEqual([1, 2, 3]);
    expect(stamps).toEqual([0, 500, 1_000]);
  });

  it("stops applying initial once usable headers are observed", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 10, 90_000) }, {}]);
    const fetch = pacer(fn, {
      initial: { limit: 1, windowMs: 60_000 }, // would force 60s spacing
      jitter: "none",
    });
    await fetch(URL_A);
    const second = fetch(URL_A);
    await second; // adaptive mode: plenty of budget → no 60s pause
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBeLessThan(1_000);
  });
});

/* ------------------------------------------------------------------ *
 * Retries
 * ------------------------------------------------------------------ */

describe("retries", () => {
  it("retries 429 exactly after Retry-After, which also wins over the quota reset", async () => {
    const { fn, calls } = scriptedFetch([
      { status: 429, headers: { "retry-after": "5", ...gh(10, 0, 90_000) } },
      {},
    ]);
    const fetch = pacer(fn, { jitter: "none" });
    const promise = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2); // exactly one retry
    expect(calls[1]! - calls[0]!).toBe(5_000); // not the 90s quota reset
  });

  it("retries a custom retryOn status (403) after Retry-After", async () => {
    const { fn, calls } = scriptedFetch([{ status: 403, headers: { "retry-after": "2" } }, {}]);
    const fetch = pacer(fn, { retryOn: [403], jitter: "none" });
    const promise = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBe(2_000);
  });

  it("backs off exponentially (1s, 2s, …) when 429 has no Retry-After", async () => {
    const { fn, calls } = scriptedFetch([{ status: 429 }, { status: 429 }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    const promise = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(3_000);
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(3);
    expect(calls[1]! - calls[0]!).toBe(1_000);
    expect(calls[2]! - calls[1]!).toBe(2_000);
  });

  it("keeps waiting for the quota reset when 429 carries headers but no Retry-After", async () => {
    const { fn, calls } = scriptedFetch([{ status: 429, headers: gh(10, 0, 60_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    const promise = fetch(URL_A);
    await vi.advanceTimersByTimeAsync(1_000); // backoff elapses, still paused
    expect(calls.length).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000); // the epoch gap is ≤ 60_999
    const res = await promise;
    expect(res.status).toBe(200);
    expect(calls.length).toBe(2);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(60_000);
    expect(calls[1]! - calls[0]!).toBeLessThan(61_000);
  });

  it("throws PacerExhaustedError with .response and .attempts when maxRetries is 0", async () => {
    const { fn, calls } = scriptedFetch([{ status: 429, headers: { "retry-after": "5" } }]);
    const fetch = pacer(fn, { maxRetries: 0, jitter: "none" });
    let caught: unknown;
    try {
      await fetch(URL_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PacerExhaustedError);
    const exhausted = caught as PacerExhaustedError;
    expect(exhausted.attempts).toBe(1);
    expect(exhausted.response.status).toBe(429);
    expect(exhausted.response.headers.get("retry-after")).toBe("5");
    expect(exhausted.message).toContain("429");
    expect(calls.length).toBe(1);
  });

  it("gives up after a 429 storm (maxRetries retries → attempts = maxRetries + 1)", async () => {
    const { fn, calls } = scriptedFetch([{ status: 429 }]); // always 429
    const fetch = pacer(fn, { maxRetries: 2, jitter: "none" });
    let caught: unknown;
    const promise = fetch(URL_A).catch((err: unknown) => {
      caught = err;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;
    expect(caught).toBeInstanceOf(PacerExhaustedError);
    expect((caught as PacerExhaustedError).attempts).toBe(3);
    expect(calls.length).toBe(3);
  });

  it("does not retry statuses outside retryOn", async () => {
    const { fn, calls } = scriptedFetch([{ status: 500 }]);
    const fetch = pacer(fn, { jitter: "none" });
    const res = await fetch(URL_A);
    expect(res.status).toBe(500);
    expect(calls.length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

describe("maxConcurrent", () => {
  it("caps in-flight requests per key", async () => {
    const p = new Pacer({ maxConcurrent: 2, jitter: "none" });
    let inflight = 0;
    let maxInflight = 0;
    const starts: number[] = [];
    const job = async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      starts.push(Date.now() - t0);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      inflight--;
    };
    const all = await (async () => {
      const jobs = [p.schedule(job), p.schedule(job), p.schedule(job)];
      await vi.advanceTimersByTimeAsync(200);
      return Promise.all(jobs);
    })();
    expect(all).toEqual([undefined, undefined, undefined]);
    expect(maxInflight).toBe(2);
    expect(starts).toEqual([0, 0, 100]); // the third waits for a free slot
  });

  it("aborts a request queued for a concurrency slot and returns the slot", async () => {
    const p = new Pacer({ maxConcurrent: 1, jitter: "none" });
    const slow = p.schedule(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)));
    const controller = new AbortController();
    const queued = p.schedule(() => Promise.resolve("never"), {
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0); // let both enter the limiter
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await slow;
  });

  it("also returns the aborted request's budget slot to the quota", async () => {
    // shouldPause at `remaining <= 0` distinguishes a restored budget slot
    // (remaining 1 → dispatch now) from a lost one (remaining 0 → pause).
    const p = new Pacer({
      maxConcurrent: 1,
      jitter: "none",
      shouldPause: (s) => s.remaining <= 0,
    });
    p.observe(new Response("ok", { headers: gh(2, 2, 90_000) }), "default");

    const slow = p.schedule(() => new Promise<void>((resolve) => setTimeout(resolve, 1_000)), {
      key: "default",
    });
    const controller = new AbortController();
    const queued = p.schedule(() => Promise.resolve("never"), {
      key: "default",
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(0); // slow holds the slot, queued waits
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(1_000);
    await slow;

    let dispatched = 0;
    const third = p.schedule(
      () => {
        dispatched++;
        return Promise.resolve("done");
      },
      { key: "default" },
    );
    await vi.advanceTimersByTimeAsync(0);
    // observed 2 − slow (−1) − queued (−1) + returned (+1) = 1 → spendable
    expect(dispatched).toBe(1);
    await third;
  });
});

/* ------------------------------------------------------------------ *
 * AbortSignal
 * ------------------------------------------------------------------ */

describe("AbortSignal", () => {
  it("rejects a paused request immediately with AbortError", async () => {
    const { fn, calls } = scriptedFetch([{ headers: gh(10, 0, 90_000) }, {}]);
    const fetch = pacer(fn, { jitter: "none" });
    await fetch(URL_A);

    const controller = new AbortController();
    const promise = fetch(URL_B, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.length).toBe(1); // never dispatched
  });

  it("forwards the signal to the scheduled callback", async () => {
    const p = new Pacer();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const value = await p.schedule(
      (signal) => {
        received = signal;
        return Promise.resolve(42);
      },
      { signal: controller.signal },
    );
    expect(value).toBe(42);
    expect(received).toBe(controller.signal);
  });
});

/* ------------------------------------------------------------------ *
 * State reporting
 * ------------------------------------------------------------------ */

describe("onStateChange", () => {
  it("reports parsed states and null for garbage", () => {
    const seen: Array<[string, RateLimitState | null]> = [];
    const p = new Pacer({ onStateChange: (key, state) => seen.push([key, state]) });
    const key = "https://api.example.com";

    p.observe(new Response("ok", { headers: gh(60, 59, 1_000) }), key);
    expect(seen[0]![0]).toBe(key);
    expect(seen[0]![1]).toMatchObject({ limit: 60, remaining: 59 });

    p.observe(new Response("ok", { headers: { "x-ratelimit-limit": "abc" } }), key);
    expect(seen[1]![1]).toBeNull();
  });

  it("reports non-request quota units but does not pace them", async () => {
    const seen: Array<RateLimitState | null> = [];
    const headers = {
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "0",
      "x-ratelimit-reset-tokens": "90s",
    };
    const { fn, calls } = scriptedFetch([{ headers }, {}]);
    const fetch = pacer(fn, {
      onStateChange: (_key, state) => seen.push(state),
      jitter: "none",
    });
    await fetch(URL_A);

    const second = fetch(URL_A);
    await second; // token quota must not pause request pacing
    expect(calls.length).toBe(2);
    expect(seen[0]).toMatchObject({ unit: "tokens", remaining: 0 });
  });

  it("keys observations by the response URL origin by default", () => {
    const seen: Array<[string, RateLimitState | null]> = [];
    const p = new Pacer({ onStateChange: (key, state) => seen.push([key, state]) });
    // Response.url is only populated by fetch(); observe() falls back to
    // "default" for hand-crafted responses unless a key is passed.
    p.observe(new Response("ok", { headers: gh(10, 5, 1_000) }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual(["default", expect.objectContaining({ remaining: 5 })]);
  });
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

describe("wait helpers", () => {
  it("jitterMs stays within its envelope", () => {
    expect(jitterMs(5_000, "none")).toBe(0);
    expect(jitterMs(-1, "full")).toBe(0);
    const small = jitterMs(1_000, "full");
    expect(small).toBeGreaterThanOrEqual(0);
    expect(small).toBeLessThanOrEqual(100); // 10% of 1s
    const large = jitterMs(10_000_000, "full");
    expect(large).toBeGreaterThanOrEqual(0);
    expect(large).toBeLessThanOrEqual(1_000); // capped at 1s
  });

  it("backoffMs grows exponentially from 1s", () => {
    expect(backoffMs(1)).toBe(1_000);
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(5)).toBe(16_000);
  });

  it("SystemClock exposes the current time", () => {
    const clock = new SystemClock();
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThanOrEqual(50);
  });
});
