import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import axios, { AxiosError, type AxiosResponse } from "axios";
import got, { HTTPError, RequestError } from "got";
import { request as undiciRequest } from "undici";
import { wrapAxios } from "../../src/adapters/axios.js";
import { wrapGot } from "../../src/adapters/got.js";
import { wrapUndici } from "../../src/adapters/undici.js";
import { PacerExhaustedError } from "../../src/errors.js";

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

/**
 * Runs four paced requests against a 3-slot bucket whose reset lands
 * ~1.2s after the call: the first three flow back-to-back, the fourth
 * must wait for the advertised reset. Returns the server hit count,
 * completion stamps and the reset point in the monotonic timeline.
 */
async function paceFourRequests(request: (url: string) => Promise<unknown>): Promise<{
  hits: number;
  stamps: number[];
  resetMono: number;
}> {
  const wallAtStart = Date.now();
  const monoAtStart = performance.now();
  const resetEpochSec = Math.ceil((wallAtStart + 1_200) / 1000);
  const resetMono = wallToMono(resetEpochSec * 1000, wallAtStart, monoAtStart);

  let hits = 0;
  handler = (_req, res) => {
    hits++;
    // responses report remaining 3→2→1→0
    const remaining = Math.max(0, 4 - hits);
    res.writeHead(200, {
      "content-type": "text/plain",
      "x-ratelimit-limit": "3",
      "x-ratelimit-remaining": String(remaining),
      "x-ratelimit-reset": String(resetEpochSec),
    });
    res.end("ok");
  };

  const stamps: number[] = [];
  for (let i = 0; i < 4; i++) {
    await request(`${base}/items?page=${i}`);
    stamps.push(performance.now()); // stamped at completion ≈ dispatch + RTT
  }
  return { hits, stamps, resetMono };
}

/** First hit answers 429 + Retry-After, every later one a plain 200 JSON. */
function one429(retryAfterSec: number): Handler {
  let hits = 0;
  return (_req, res) => {
    hits++;
    if (hits === 1) {
      res.writeHead(429, { "retry-after": String(retryAfterSec) });
      res.end("slow down");
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "x-ratelimit-remaining": "9" });
    res.end('{"ok":true}');
  };
}

/** An exhausted bucket (remaining 0 far in the future) to force pauses. */
function exhausted(): Handler {
  return (_req, res) => {
    res.writeHead(200, {
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.ceil((Date.now() + 60_000) / 1000)),
    });
    res.end("ok");
  };
}

/** Aborts `promise`'s controller mid-pause and expects a fast AbortError. */
async function expectFastAbort(
  promise: Promise<unknown>,
  controller: AbortController,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20)); // let it enter the pause
  const tAbort = performance.now();
  controller.abort();
  await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  expect(performance.now() - tAbort).toBeLessThanOrEqual(10);
}

describe("axios adapter", () => {
  it("paces 4 requests against a 3-slot bucket without overdrawing it", async () => {
    const api = wrapAxios(axios.create(), { jitter: "none" });
    const { hits, stamps, resetMono } = await paceFourRequests(async (url) => {
      const res = await api(url); // callable form
      expect(res.status).toBe(200); // not a single 429
      expect(res.data).toBe("ok");
    });

    expect(hits).toBe(4);
    // First three flow back-to-back…
    expect(stamps[2]! - stamps[0]!).toBeLessThan(1_000);
    // …and the fourth waits for the advertised reset (50ms scheduling slack).
    expect(stamps[3]! - stamps[2]!).toBeGreaterThanOrEqual(resetMono - stamps[2]! - 50);
    expect(stamps[3]!).toBeLessThan(resetMono + 500);
  }, 10_000);

  it("retries a real 429 after Retry-After and resolves the native response", async () => {
    let hits = 0;
    const script = one429(1);
    handler = (req, res) => {
      hits++;
      script(req, res);
    };
    const api = wrapAxios(axios.create(), { jitter: "none" });

    const t0 = performance.now();
    const res = await api.get(`${base}/limited`); // method shortcut
    const elapsed = performance.now() - t0;

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    expect(hits).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1_000 - 50);
    expect(elapsed).toBeLessThan(2_500);
  });

  it("exposes every axios shortcut", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };
    const api = wrapAxios(axios.create(), { jitter: "none" });
    const responses = await Promise.all([
      api.request({ method: "get", url: `${base}/shortcut` }),
      api.put(`${base}/shortcut`, { id: 1 }),
      api.patch(`${base}/shortcut`, { id: 1 }),
      api.delete(`${base}/shortcut`),
      api.head(`${base}/shortcut`),
    ]);
    for (const res of responses) expect(res.status).toBe(200);
  });

  it("runs through the instance's interceptors", async () => {
    let sawHeader: string | undefined;
    handler = (req, res) => {
      sawHeader = req.headers["x-added"] as string | undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };

    const instance = axios.create();
    instance.interceptors.request.use((cfg) => {
      cfg.headers.set("x-added", "yes");
      return cfg;
    });
    instance.interceptors.response.use((res) => {
      (res.data as Record<string, unknown>).intercepted = true;
      return res;
    });

    const api = wrapAxios(instance, { jitter: "none" });
    const res = await api.post(`${base}/interop`);
    expect(sawHeader).toBe("yes");
    expect(res.data).toEqual({ ok: true, intercepted: true });
  });

  it("throws PacerExhaustedError with the native AxiosResponse when maxRetries is 0", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(429, { "retry-after": "60" });
      res.end("slow down");
    };
    const api = wrapAxios(axios.create(), { maxRetries: 0 });

    let caught: unknown;
    try {
      await api.get(`${base}/limited`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PacerExhaustedError);
    const err = caught as PacerExhaustedError<AxiosResponse>;
    expect(err.attempts).toBe(1);
    expect(hits).toBe(1);
    expect(err.response.status).toBe(429); // the native AxiosResponse
    expect(err.response.data).toBe("slow down");
  });

  it("rethrows axios's own AxiosError for non-retryable statuses", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(403, { "retry-after": "1" });
      res.end("forbidden");
    };
    const api = wrapAxios(axios.create(), { maxRetries: 3 });

    let caught: unknown;
    try {
      await api.get(`${base}/forbidden`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AxiosError); // not PacerExhaustedError
    const err = caught as AxiosError;
    expect(err.response?.status).toBe(403);
    expect(err.response?.data).toBe("forbidden");
    expect(hits).toBe(1); // no retry for 403
  });

  it("aborts a paused request with AbortError within 10ms", async () => {
    handler = exhausted();
    const api = wrapAxios(axios.create(), { jitter: "none" });
    await api.get(`${base}/warmup`); // observes the exhausted bucket

    const controller = new AbortController();
    const promise = api.get(`${base}/paused`, { signal: controller.signal });
    await expectFastAbort(promise, controller);
  });
});

describe("got adapter", () => {
  it("paces 4 requests against a 3-slot bucket without overdrawing it", async () => {
    const paced = wrapGot(got, { jitter: "none" });
    const { hits, stamps, resetMono } = await paceFourRequests(async (url) => {
      const res = await paced(url, { retry: { limit: 0 } });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("ok");
    });

    expect(hits).toBe(4);
    expect(stamps[2]! - stamps[0]!).toBeLessThan(1_000);
    expect(stamps[3]! - stamps[2]!).toBeGreaterThanOrEqual(resetMono - stamps[2]! - 50);
    expect(stamps[3]!).toBeLessThan(resetMono + 500);
  }, 10_000);

  it("retries a real 429 after Retry-After and resolves the native response", async () => {
    let hits = 0;
    const script = one429(1);
    handler = (req, res) => {
      hits++;
      script(req, res);
    };
    const paced = wrapGot(got, { jitter: "none" });

    const t0 = performance.now();
    const res = await paced(`${base}/limited`, { retry: { limit: 0 } });
    const elapsed = performance.now() - t0;

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('{"ok":true}'); // native string body by default
    expect(hits).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1_000 - 50);
    expect(elapsed).toBeLessThan(2_500);
  });

  it("parses JSON bodies via responseType", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    };
    const paced = wrapGot(got, { jitter: "none" });
    const res = await paced(`${base}/json`, { responseType: "json", retry: { limit: 0 } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("rethrows got's own HTTPError for non-retryable statuses", async () => {
    let hits = 0;
    handler = (_req, res) => {
      hits++;
      res.writeHead(403, { "retry-after": "1" });
      res.end("forbidden");
    };
    const paced = wrapGot(got, { maxRetries: 3 });

    let caught: unknown;
    try {
      await paced(`${base}/forbidden`, { retry: { limit: 0 } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HTTPError); // not PacerExhaustedError
    const err = caught as HTTPError;
    expect(err.response.statusCode).toBe(403);
    expect(hits).toBe(1); // no retry for 403
  });

  it("propagates network errors untouched", async () => {
    // A closed port guarantees ECONNREFUSED without touching the network.
    const tmp = createServer();
    await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise<void>((resolve) => tmp.close(() => resolve()));

    const paced = wrapGot(got, { jitter: "none" });
    await expect(
      paced(`http://127.0.0.1:${port}/nope`, { retry: { limit: 0 } }),
    ).rejects.toBeInstanceOf(RequestError);
  });

  it("aborts a paused request with AbortError within 10ms", async () => {
    handler = exhausted();
    const paced = wrapGot(got, { jitter: "none" });
    await paced(`${base}/warmup`, { retry: { limit: 0 } }); // observes the exhausted bucket

    const controller = new AbortController();
    const promise = paced(`${base}/paused`, {
      retry: { limit: 0 },
      signal: controller.signal,
    });
    await expectFastAbort(promise, controller);
  });
});

describe("undici adapter", () => {
  it("paces 4 requests against a 3-slot bucket without overdrawing it", async () => {
    const pacedRequest = wrapUndici(undiciRequest, { jitter: "none" });
    const { hits, stamps, resetMono } = await paceFourRequests(async (url) => {
      const res = await pacedRequest(url);
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe("ok");
    });

    expect(hits).toBe(4);
    expect(stamps[2]! - stamps[0]!).toBeLessThan(1_000);
    expect(stamps[3]! - stamps[2]!).toBeGreaterThanOrEqual(resetMono - stamps[2]! - 50);
    expect(stamps[3]!).toBeLessThan(resetMono + 500);
  }, 10_000);

  it("retries a real 429 after Retry-After and dumps the discarded body", async () => {
    let hits = 0;
    const script = one429(1);
    handler = (req, res) => {
      hits++;
      script(req, res);
    };
    const pacedRequest = wrapUndici(undiciRequest, { jitter: "none" });

    const t0 = performance.now();
    const res = await pacedRequest(`${base}/limited`);
    const elapsed = performance.now() - t0;

    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('{"ok":true}');
    expect(hits).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(1_000 - 50);
    expect(elapsed).toBeLessThan(2_500);
  });

  it("resolves undici's native response fields", async () => {
    handler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "9",
      });
      res.end('{"ok":true}');
    };
    const pacedRequest = wrapUndici(undiciRequest, { jitter: "none" });
    const res = await pacedRequest(new URL(`${base}/json`), { method: "GET" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["x-ratelimit-remaining"]).toBe("9");
    expect(JSON.parse(await res.body.text())).toEqual({ ok: true });
  });

  it("aborts a paused request with AbortError within 10ms", async () => {
    handler = exhausted();
    const pacedRequest = wrapUndici(undiciRequest, { jitter: "none" });
    await (await pacedRequest(`${base}/warmup`)).body.text(); // observes the exhausted bucket

    const controller = new AbortController();
    const promise = pacedRequest(`${base}/paused`, { signal: controller.signal });
    await expectFastAbort(promise, controller);
  });
});
