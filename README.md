# pacer-http

[![CI](https://github.com/Cubex33/pacer-http/actions/workflows/ci.yml/badge.svg)](https://github.com/Cubex33/pacer-http/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://github.com/Cubex33/pacer-http/blob/main/LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Adaptive client-side rate limiting for `fetch`: read `RateLimit` / `X-RateLimit-*` / `Retry-After` headers, pause until reset, retry 429s — no guessed numbers, no hand-rolled backoff code.**

```bash
npm install pacer-http
```

```ts
import { pacer } from "pacer-http";

const fetch = pacer(globalThis.fetch, { maxConcurrent: 2 });
const res = await fetch("https://api.github.com/rate_limit");
```

That's it. Every response's rate-limit headers feed an in-memory pacer per origin; requests that would overdraw the advertised budget wait until the advertised reset instead of collecting 429s. Zero runtime dependencies, ESM + CJS, Node 20+ and browsers.

## How it works

1. Every response is parsed into a normalized state: limit, remaining, reset, policy windows, quota unit. Supported families (in priority order):
   - IETF `RateLimit` + `RateLimit-Policy` (draft-ietf-httpapi-ratelimit-headers 08+, structured fields, multi-window policies; the draft-07 combined text form is also accepted),
   - early-draft uncombined `RateLimit-Limit/-Remaining/-Reset/-ResetTime` (GitLab),
   - `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` (OpenAI; reset is a duration like `6s` / `2m33s`),
   - `anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset}` (Anthropic; reset is RFC 3339),
   - generic `x-ratelimit-{limit,remaining,reset}` with epoch-seconds or delta-seconds resets (GitHub, Square, …) and Discord's fractional epochs with `x-ratelimit-reset-after` preferred when present.
2. The pacer keeps the state **per key** (the origin by default), subtracts its own in-flight requests from `remaining`, and pauses requests that would overdraw the budget until `reset`. Pacing decisions are serialized per key under an internal mutex, so two concurrent requests can never double-spend the last slot.
3. Multi-window IETF policies pace by the **strictest** window: `10;w=1, 100;w=60` → one request per `max(1s/10, 60s/100) = 600ms`; when a window reports `remaining=0`, the pause runs to that window's reset.
4. Responses with a status in `retryOn` (default `[429]`) are retried: **exactly `Retry-After` + jitter** when the server sends one, exponential `1s/2s/4s… + jitter` when it does not. `Retry-After` also wins over the quota headers' reset point (per the IETF draft). After `maxRetries` (default 3), a `PacerExhaustedError` is thrown with the offending response attached.
5. Garbage or missing headers never throw and never update state — `onStateChange` reports `null` and the pacer keeps whatever it knew before (or the static `initial` limit while the server reports nothing).

## Example 1 — GitHub pagination, no SDK

```ts
import { pacer } from "pacer-http";

const fetch = pacer(globalThis.fetch, { maxConcurrent: 2 });

let url = "https://api.github.com/orgs/nodejs/repos?per_page=100&page=1";
while (url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const repos = await res.json();
  console.log(repos.length, "repos, remaining:", res.headers.get("x-ratelimit-remaining"));
  const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
  url = next ? next[1] : null;
}
```

Run the offline version (a local mock server with GitHub-style headers) after building:

```bash
npm run build
node examples/github-pagination.mjs
```

## Example 2 — plain request loop against any API

```ts
import { pacer, PacerExhaustedError } from "pacer-http";

const fetch = pacer(globalThis.fetch, {
  retryOn: [429], // some APIs signal rate limits with 403 + Retry-After: add 403
  maxRetries: 5,
  onStateChange: (key, state) => {
    if (state)
      console.log(key, `${state.remaining}/${state.limit} until ${state.reset?.toISOString()}`);
  },
  onRetry: ({ key, status, attempt, delayMs, retryAfterMs }) =>
    console.log(
      `${key}: got ${status}, retry #${attempt} in ${delayMs}ms` +
        ` (server asked for ${retryAfterMs ?? "no Retry-After"})`,
    ),
});

for (const id of ids) {
  try {
    const res = await fetch(`https://api.example.com/items/${id}`);
    await consume(res);
  } catch (err) {
    if (err instanceof PacerExhaustedError) {
      console.error(`gave up on ${id} after ${err.attempts} attempts`, err.response.status);
      continue;
    }
    throw err;
  }
}
```

## Adapters (axios, got, undici)

The same engine ships as thin adapters for the three popular Node clients. They reference the client **only as types** — the client itself is injected — so pacer-http keeps zero runtime dependencies; axios / got / undici are optional peer dependencies:

```bash
npm install pacer-http axios   # or got / undici — whichever you use
```

All adapters resolve the client's **native response** (`AxiosResponse`, got's `Response`, undici's `{ statusCode, headers, body }`), forward `signal` (aborting pacing waits and the request), honor `Retry-After`, and attach that native response to `PacerExhaustedError` when the retry budget runs out. Responses that are not retried are delivered exactly as the client would deliver them — including the client's own error class for non-2xx statuses (`AxiosError`, `HTTPError`). Bucket keys come from the request URL; a custom `key` receives the URL and the client's request options as `init`.

### axios

```ts
import axios from "axios";
import { wrapAxios } from "pacer-http/axios";

const api = wrapAxios(axios.create({ baseURL: "https://api.github.com" }));

const res = await api.get("/rate_limit"); // res is a native AxiosResponse
console.log(res.status, res.data.rate);
```

The wrapper calls **through** your instance (`instance.request(config)`), so interceptors, `baseURL`, defaults and adapters keep working. It exposes the usual shortcuts: the callable form `api(url, config)` plus `request`, `get`, `post`, `put`, `patch`, `delete`, `head`.

> **Don't stack retries.** pacer-http already retries `retryOn` statuses (429 by default). Combining it with `axios-retry` would retry the same 429 twice — disable one of them.

### got

```ts
import got from "got";
import { wrapGot } from "pacer-http/got";

const paced = wrapGot(got);
const res = await paced("https://api.github.com/rate_limit", {
  retry: { limit: 0 }, // pacer-http owns retries
  responseType: "json",
});
console.log(res.statusCode, res.body);
```

`wrapGot` accepts `got` itself or a `got.extend()` instance. The returned promise resolves got's full response — it intentionally does **not** carry got's `.json()` / `.text()` / `.buffer()` shortcuts (they re-configure the pending request and do not compose with retries): pass `responseType` and read `response.body` instead.

> **Don't stack retries.** got retries 429s by default (`retry.limit: 2`); set `retry: { limit: 0 }` (as above), or keep got's retry only if you deliberately want it to handle non-rate-limit statuses.

### undici

```ts
import { request } from "undici";
import { wrapUndici } from "pacer-http/undici";

const pacedRequest = wrapUndici(request);
const { statusCode, headers, body } = await pacedRequest("https://api.github.com/rate_limit");
console.log(statusCode, headers["x-ratelimit-remaining"]);
console.log(await body.json());
```

Bodies of responses dropped for a retry are dumped automatically, so the connection can be reused. If you use undici's fetch-shaped API, the plain wrapper works without an adapter: `pacer(undici.fetch)`.

## When NOT to use this

- **You already use a provider SDK that throttles itself.** `octokit/plugin-throttling` parses GitHub's headers, `openai-node` parses OpenAI's — adding pacer-http on top duplicates the work. Wrap the SDK's transport only if you must share one budget across processes (pacer-http is in-memory and per-instance).
- **You need a hard cap you chose yourself.** pacer-http is _adaptive_: it believes the server. To enforce your own quota ("max 10 rps no matter what the server says") use a token-bucket limiter such as Bottleneck — or pass a static `initial` and only talk to APIs without headers.
- **Token-quota (not request-quota) pacing.** OpenAI/Anthropic token budgets depend on payload size, which the client can't predict. pacer-http parses and reports token units via `onStateChange` but deliberately does not pace them.
- **Cross-process coordination.** State is per-instance; multiple processes share nothing. The server is the only real coordination point anyway.
- **Non-fetch clients that can't feed responses back.** If you can't intercept response headers, there is nothing to be adaptive about. (You can still use the static `initial` mode.)

## Migrating from Bottleneck

| Bottleneck                                                                        | pacer-http                                       | Notes                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `new Bottleneck({ reservoir, reservoirRefreshAmount, reservoirRefreshInterval })` | `{ initial: { limit, windowMs } }`               | `initial` is only a fallback until the server reports real headers.                                  |
| `new Bottleneck({ maxConcurrent })`                                               | `{ maxConcurrent }`                              | Per key (origin) instead of global.                                                                  |
| `new Bottleneck({ minTime })`                                                     | —                                                | Let the server's headers pick the interval; multi-window policies do this automatically.             |
| `limiter.schedule(fn)`                                                            | `new Pacer().schedule(fn)` or wrap your fetch    | Same mental model: the promise resolves when it's your turn.                                         |
| `limiter.wrap(fn)`                                                                | `pacer(fetch)`                                   | pacer-http wraps the transport, not each task.                                                       |
| `retryOptions` on `schedule`                                                      | built-in: `retryOn`, `maxRetries`, `Retry-After` | Bottleneck retries on error events; pacer-http retries on response statuses, honoring `Retry-After`. |
| `limiter.on("error", …)`                                                          | `try/catch` around `await fetch(...)`            | `PacerExhaustedError` carries the last `.response` and `.attempts`.                                  |
| `limiter.stop()`                                                                  | `AbortSignal` per request                        | Pass `signal` in `init`; paused requests reject with `AbortError` immediately.                       |
| Clusters / Redis                                                                  | —                                                | Out of scope by design.                                                                              |

## Options

All optional. `pacer(fetchFn, opts)` / `new Pacer(opts)`.

| Option          | Type                                  | Default                 | Description                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initial`       | `{ limit: number; windowMs: number }` | —                       | Static fallback while the server reports no rate-limit headers: requests are paced `windowMs / limit` apart. Dropped as soon as usable headers arrive.                                                                                                                                                                                        |
| `maxConcurrent` | `number`                              | `Infinity`              | Max requests in flight, counted per key.                                                                                                                                                                                                                                                                                                      |
| `retryOn`       | `number[]`                            | `[429]`                 | Statuses that trigger a retry. Add `403` for APIs that signal rate limits that way.                                                                                                                                                                                                                                                           |
| `maxRetries`    | `number`                              | `3`                     | Retries per request after the first attempt. `0` → first retryable response throws `PacerExhaustedError` with `attempts: 1`.                                                                                                                                                                                                                  |
| `jitter`        | `"full" \| "none"`                    | `"full"`                | `"full"` adds `0..min(1s, wait·10%)` on top of every pause/retry wait so synchronized clients don't stampede at reset. Interval pacing is never jittered.                                                                                                                                                                                     |
| `key`           | `(url, init) => string`               | URL origin              | Bucketing function.                                                                                                                                                                                                                                                                                                                           |
| `maxWaitMs`     | `number`                              | `900000`                | Cap for a single pause. A pause truncated by this cap happens at most once per reset point — after it, the request proceeds (liveness over strictness).                                                                                                                                                                                       |
| `shouldPause`   | `(state) => boolean`                  | `s => s.remaining <= 1` | Proactive pause decision. Receives the state with `remaining` adjusted for requests already dispatched in this window (`Infinity` when unknown). The default never consumes the last slot.                                                                                                                                                    |
| `onStateChange` | `(key, state \| null) => void`        | —                       | Metrics hook; fires on every observed response. `null` = no/garbage headers.                                                                                                                                                                                                                                                                  |
| `onRetry`       | `(info: RetryInfo) => void`           | —                       | Observability hook; fires exactly once right before every retry with `{ key, status, attempt, delayMs, retryAfterMs }` — `attempt` counts the upcoming attempt (first retry = 2), `delayMs` includes jitter, `retryAfterMs` is the parsed `Retry-After` in ms or `null`. Callback exceptions propagate to the caller, like `onStateChange`'s. |
| `clock`         | `Clock`                               | `SystemClock`           | Time source injection for deterministic tests (`now()` + `sleep()`).                                                                                                                                                                                                                                                                          |

### `Pacer` (for non-fetch clients)

```ts
import { Pacer } from "pacer-http";

const p = new Pacer({ maxConcurrent: 4 });

// run a task under pacing; returns when it's its turn
const data = await p.schedule(
  (signal) => myClient.get("/items", { signal }),
  { key: "https://api.example.com" }, // bucket; "default" when omitted
);

// feed every response back so the pacer learns
p.observe(response); // key defaults to the origin of response.url

// inspect or forget the learned state
p.getState("https://api.example.com"); // RateLimitState | undefined
p.reset("https://api.example.com"); // or p.reset() for every key
```

`pacer(fetchFn, opts)` is sugar over `Pacer#fetch`, which is public too (`engine.fetch(fetchLike, input, init)`) for fetch-shaped clients that aren't assignable to `typeof fetch`. `Pacer#runWithRetry(dispatch, view, opts)` is the client-agnostic retry loop behind `fetch` and every adapter — use it to build an adapter for a client we don't ship one for.

### Semantics worth knowing

- **The last slot.** By default (`shouldPause: s => s.remaining <= 1`) the pacer stops _before_ consuming the last advertised slot and waits for reset. Set `s => s.remaining <= 0` to spend the last slot too — then, with `remaining: 1` and two concurrent requests, exactly one dispatches now and the other waits for reset (decisions are serialized by an internal per-key mutex).
- **Resync.** Every new observation replaces the state: a grown `remaining` (new window) cancels pending pauses; a shrunken one tightens them.
- **`Retry-After` precedence.** On a `retryOn` response with a positive `Retry-After`, the retry happens exactly `Retry-After` (+ jitter) later, and the deadline overrides the quota headers' reset point. `Retry-After: 0`, absent, or unparseable → exponential backoff from 1s (+ jitter). A 429 _with_ quota headers but _without_ `Retry-After` keeps the limiter's pause-until-reset dominant.
- **Quota units ≠ requests** (OpenAI/Anthropic tokens, `qu="content-bytes"`): parsed and reported through `onStateChange`, never paced.
- **Introspection and reset.** `getState(key)` returns the effective state the next decision would use — `remaining` already adjusted for requests dispatched in this window (`Infinity` while the server hasn't reported a quota), the reset point (possibly overridden by `Retry-After`) — or `undefined` for keys never seen. `reset(key?)` forgets the learned state and falls back to the static `initial` pacing; pauses already in progress are **not** interrupted — they sleep out and re-decide against the cleared state (abort one with a `signal` to cut it short), and concurrency slots of in-flight requests are preserved.
- **Clock.** Every decision and wait goes through the injected `clock`; nothing reads `new Date()` or `setTimeout` directly.

## Error behavior

- Bad headers (NaN, negative reset, `remaining > limit`, malformed structured fields) never throw: the family is ignored, the previous state stands, `onStateChange` gets `null`.
- A retryable status that outlives `maxRetries` throws `PacerExhaustedError` with `.response` (the last response, headers included) and `.attempts` (total requests made, first one included). Network errors from the underlying fetch propagate as-is. Adapters behave the same way, except that non-retried responses are delivered through the client's own error class (`AxiosError`, `HTTPError`) and `PacerExhaustedError.response` is the client's native response object.
- Abort during pacing, a concurrency queue, or a retry wait rejects with `AbortError` (`DOMException` where available).
- A pause longer than `maxWaitMs` is truncated once; the request then proceeds rather than waiting forever.

## Development

```bash
npm install
npm run build        # ESM + CJS into dist/
npm test             # unit + integration (localhost only, no network)
npm run test:coverage
npm run typecheck    # tsc --noEmit
npm run lint         # eslint + prettier
```

MIT.
