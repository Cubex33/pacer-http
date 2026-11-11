import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Pacer } from "../../src/pacer.js";

/** GitHub-style headers; reset is `resetInMs` from "now". */
function gh(limit: number, remaining: number, resetInMs: number): Headers {
  return new Headers({
    "x-ratelimit-limit": String(limit),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.ceil((Date.now() + resetInMs) / 1000)),
  });
}

/** A fetch stub whose scripted responses reuse one bucket key. */
function scriptedFetch(script: Array<Headers | Record<string, string>>) {
  const calls: number[] = [];
  const fn = (_input: Request | string | URL): Promise<Response> => {
    calls.push(Date.now());
    const next = script[Math.min(calls.length - 1, script.length - 1)] ?? {};
    return Promise.resolve(new Response("ok", { status: 200, headers: next }));
  };
  return { fn, calls };
}

const KEY = "https://api.example.com";

let t0: number;

beforeEach(() => {
  vi.useFakeTimers();
  t0 = Date.now();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getState", () => {
  it("returns undefined for unknown keys", () => {
    const p = new Pacer();
    expect(p.getState(KEY)).toBeUndefined();
  });

  it("snapshots the observed state (limit, remaining, reset, windows)", async () => {
    const p = new Pacer({ jitter: "none" });
    const resetInMs = 60_000;
    await p.observe(new Response("ok", { status: 200, headers: gh(10, 5, resetInMs) }), KEY);

    const snap = p.getState(KEY);
    expect(snap).toBeDefined();
    expect(snap!.limit).toBe(10);
    expect(snap!.remaining).toBe(5);
    expect(snap!.reset).toBeInstanceOf(Date);
    expect(snap!.reset!.getTime()).toBeGreaterThanOrEqual(t0 + resetInMs);
    expect(snap!.reset!.getTime()).toBeLessThan(t0 + resetInMs + 1_000);
    expect(snap!.windows).toEqual([]);
  });

  it("reflects requests dispatched since the observation", async () => {
    const { fn, calls } = scriptedFetch([gh(10, 5, 60_000), {}]);
    const p = new Pacer({ jitter: "none" });
    await p.fetch(fn, KEY); // observes remaining=5
    expect(p.getState(KEY)!.remaining).toBe(5);

    await p.fetch(fn, KEY); // dispatched; the {} response reports no headers
    expect(calls.length).toBe(2);
    expect(p.getState(KEY)!.remaining).toBe(4); // 5 minus our own dispatch
  });

  it("rolls a passed reset point over (budget unknown again)", async () => {
    const p = new Pacer({ jitter: "none" });
    await p.observe(new Response("ok", { status: 200, headers: gh(10, 0, 1_000) }), KEY);
    expect(p.getState(KEY)!.remaining).toBe(0);

    // 2.1s covers the epoch-second ceil of the advertised reset point.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(p.getState(KEY)!.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it("reports the Retry-After override of the reset point", async () => {
    const p = new Pacer({ jitter: "none" });
    const res = new Response("slow down", {
      status: 429,
      headers: { "retry-after": "5", ...Object.fromEntries(gh(10, 0, 60_000)) },
    });
    await p.observe(res, KEY);
    const snap = p.getState(KEY)!;
    expect(snap.reset!.getTime()).toBeGreaterThanOrEqual(t0 + 5_000);
    expect(snap.reset!.getTime()).toBeLessThan(t0 + 5_100);
  });
});

describe("reset", () => {
  it("clears a key's observed state", async () => {
    const p = new Pacer({ jitter: "none" });
    await p.observe(new Response("ok", { status: 200, headers: gh(10, 0, 60_000) }), KEY);
    expect(p.getState(KEY)!.remaining).toBe(0);

    p.reset(KEY);
    const snap = p.getState(KEY)!;
    expect(snap).toEqual({
      limit: -1,
      remaining: Number.POSITIVE_INFINITY,
      reset: null,
      windows: [],
    });
  });

  it("clears every key when no key is given", async () => {
    const p = new Pacer({ jitter: "none" });
    const other = "https://other.example.com";
    await p.observe(new Response("ok", { status: 200, headers: gh(10, 0, 60_000) }), KEY);
    await p.observe(new Response("ok", { status: 200, headers: gh(20, 0, 60_000) }), other);
    expect(p.getState(KEY)!.limit).toBe(10);
    expect(p.getState(other)!.limit).toBe(20);

    p.reset();
    expect(p.getState(KEY)!.limit).toBe(-1);
    expect(p.getState(other)!.limit).toBe(-1);
  });

  it("is a no-op for unknown keys", () => {
    const p = new Pacer();
    expect(() => p.reset("https://never-seen.example.com")).not.toThrow();
    expect(p.getState("https://never-seen.example.com")).toBeUndefined();
  });

  it("does not interrupt an in-progress pause: the task re-decides at its wake time", async () => {
    const p = new Pacer({ jitter: "none" });
    await p.observe(new Response("ok", { status: 200, headers: gh(10, 0, 60_000) }), KEY);

    let dispatched = false;
    const second = p.schedule(
      () => {
        dispatched = true;
        return Promise.resolve(42);
      },
      { key: KEY },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dispatched).toBe(false); // paused until the advertised reset

    p.reset(KEY); // state gone…
    await vi.advanceTimersByTimeAsync(50_000);
    expect(dispatched).toBe(false); // …but the pause itself is not interrupted

    await vi.advanceTimersByTimeAsync(11_000); // past the original wake point
    await second;
    expect(dispatched).toBe(true); // re-decided against cleared state → dispatches
  });

  it("restores the static initial spacing for future requests", async () => {
    const { fn, calls } = scriptedFetch([gh(10, 9, 60_000), gh(10, 9, 60_000), {}]);
    const p = new Pacer({ jitter: "none", initial: { limit: 2, windowMs: 2_000 } });

    await p.fetch(fn, KEY); // t0: static mode (no state yet), interval 1000ms
    await p.fetch(fn, KEY); // dispatches back-to-back: observed state has no windows
    expect(calls.length).toBe(2);
    // After the first observation (headers, no windows) the interval is 0:
    // the second request dispatches back-to-back.
    expect(calls[1]! - calls[0]!).toBe(0);

    p.reset(KEY); // back to the static interval (1000ms)
    const third = p.fetch(fn, KEY);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls.length).toBe(2); // still waiting for the last dispatch + 1000ms
    await vi.advanceTimersByTimeAsync(1);
    await third;
    expect(calls.length).toBe(3);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(1_000);
  });

  it("keeps concurrency slots of in-flight requests", async () => {
    const p = new Pacer({ jitter: "none", maxConcurrent: 1 });
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = p.schedule(() => firstDone, { key: KEY });
    await vi.advanceTimersByTimeAsync(1); // first dispatches and holds the slot

    let secondStarted = false;
    const second = p.schedule(
      () => {
        secondStarted = true;
        return Promise.resolve("done");
      },
      { key: KEY },
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(secondStarted).toBe(false); // queued behind the occupied slot

    p.reset(KEY); // resetting must not open the maxConcurrent floodgates
    await vi.advanceTimersByTimeAsync(10);
    expect(secondStarted).toBe(false);

    releaseFirst();
    await first;
    await second;
    expect(secondStarted).toBe(true);
  });
});
