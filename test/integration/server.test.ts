import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { PacerExhaustedError } from "../../src/errors.js";
import { pacer } from "../../src/pacer.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler = (_req, res) => {
  res.writeHead(200);
  res.end("ok");
};

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Converts a wall-clock ms timestamp into the performance.now() timeline. */
function wallToMono(wallMs: number, wallAtStart: number, monoAtStart: number): number {
  return monoAtStart + (wallMs - wallAtStart);
}

describe("integration against a real node:http server", () => {
  it("paces 11 requests against a 10-slot bucket without overdrawing it", async () => {
    const wallAtStart = Date.now();
    const monoAtStart = performance.now();
    const resetWallMs = wallAtStart + 2_000;
    const resetEpochSec = Math.ceil(resetWallMs / 1000);
    const resetMono = wallToMono(resetEpochSec * 1000, wallAtStart, monoAtStart);

    let hits = 0;
    handler = (_req, res) => {
      hits++;
      // first 10 responses report remaining 10→1, the 11th reports 0
      const remaining = Math.max(0, 11 - hits);
      res.writeHead(200, {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": String(remaining),
        "x-ratelimit-reset": String(resetEpochSec),
      });
      res.end("ok");
    };

    const fetch = pacer(globalThis.fetch, { jitter: "none", maxConcurrent: 1 });
    const stamps: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${base}/items?page=${i}`);
      stamps.push(performance.now()); // stamped at completion ≈ dispatch + RTT
      expect(res.status).toBe(200); // not a single 429
    }

    expect(hits).toBe(11);
    // First ten requests flow back-to-back…
    expect(stamps[9]! - stamps[0]!).toBeLessThan(1_000);
    // …and the gap between the 10th and the 11th covers the time to reset
    // (50ms tolerance for scheduling and clock skew).
    expect(stamps[10]! - stamps[9]!).toBeGreaterThanOrEqual(resetMono - stamps[9]! - 50);
    expect(stamps[10]!).toBeLessThan(resetMono + 500);
  }, 10_000);

  it("aborts a paused request with AbortError within 10ms", async () => {
    const resetEpochSec = Math.ceil((Date.now() + 60_000) / 1000);
    handler = (_req, res) => {
      res.writeHead(200, {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetEpochSec),
      });
      res.end("ok");
    };

    const fetch = pacer(globalThis.fetch, { jitter: "none" });
    await fetch(`${base}/warmup`); // observes the exhausted bucket

    const controller = new AbortController();
    const promise = fetch(`${base}/paused`, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20)); // let it enter the pause
    const tAbort = performance.now();
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - tAbort).toBeLessThanOrEqual(10);
  });

  it("retries a real 429 exactly once after Retry-After", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      if (hits === 1) {
        res.writeHead(429, {
          "retry-after": "1",
          "x-ratelimit-limit": "10",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(Math.ceil((Date.now() + 60_000) / 1000)),
        });
        res.end("slow down");
        return;
      }
      res.writeHead(200, { "x-ratelimit-remaining": "9" });
      res.end("ok");
    };

    const fetch = pacer(globalThis.fetch, { jitter: "none" });
    const t0 = performance.now();
    const res = await fetch(`${base}/limited`);
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1_000 - 50);
    expect(elapsed).toBeLessThan(2_500);
  });

  it("throws PacerExhaustedError immediately when maxRetries is 0", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(429, { "retry-after": "60" });
      res.end("slow down");
    };

    const fetch = pacer(globalThis.fetch, { maxRetries: 0 });
    let caught: unknown;
    try {
      await fetch(`${base}/limited`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PacerExhaustedError);
    expect((caught as PacerExhaustedError).attempts).toBe(1);
    expect(hits).toBe(1);
  });
});
