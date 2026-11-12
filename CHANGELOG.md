# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.1] — 2026-11-12

### Fixed

- CI failed on Node 20: the `undici` dev dependency was 8.x, which requires
  Node 22.19+ and crashes at import time on Node 20 (`zlib` has no zstd
  bindings there). Development and CI now pin undici 6, and a Node 22 job
  additionally verifies the adapter against undici 8.
- `peerDependencies.undici` is now `>=6` (was `>=5`): the adapter is typed
  against undici 6+ and 5.x is not tested.

### Changed

- README: note that undici 7+ needs Node 22.19+, so Node 20 users should
  install `undici@6`.

## [0.3.0] — 2026-11-11

### Added

- Token-dimension parsing: OpenAI (`x-ratelimit-*-tokens`), Anthropic
  (`anthropic-ratelimit-tokens-*`) and IETF `qu="tokens"` policies are
  reported as `RateLimitState.tokens` (`{ limit, remaining, reset }`, exported
  as `TokenQuota`) next to the request dimension. Tokens-only responses carry
  `unit: "tokens"` plus `tokens`; token policies are excluded from `windows`.
  Garbage token headers are ignored without discarding a valid request
  dimension; a garbage request dimension still invalidates the whole family.
- Token-aware pacing for LLM APIs: `tokenCost` (`number` or
  `(url, init) => number`) and `shouldPauseTokens` (`(q: TokenQuota) => boolean`,
  default `q.remaining <= 0`) options. Each request reserves its cost on
  dispatch and releases it when it settles, so concurrent requests cannot
  overdraw a TPM budget; requests wait for the token reset with the same
  `maxWaitMs` cap and liveness guard as the request dimension. Without
  `tokenCost` the token dimension is reported but never paced (0.2.x
  compatibility).
- `getState(key).tokens` exposes the reservation-adjusted token snapshot;
  `reset()` clears the token window as well.
- README "Token quotas (LLM APIs)" section, Options table entries, and seven
  new golden fixtures (49 total).

### Changed

- `RateLimitState` gains an optional `tokens` field; `ScheduleOptions` gains
  optional `url` / `init`, filled in by `Pacer#fetch` and the adapters so a
  functional `tokenCost` sees the request. Both are backward compatible.

## [0.2.0] — 2026-11-11

### Added

- Client adapters under `pacer-http/axios`, `pacer-http/got` and
  `pacer-http/undici` (`wrapAxios`, `wrapGot`, `wrapUndici`): the same
  adaptive engine and retry policy, returning each client's native response
  (`AxiosResponse`, got's `Response`, undici's `{ statusCode, headers, body }`).
  The clients are optional peer dependencies and are referenced only as types,
  so pacer-http still has zero runtime dependencies. `signal` is forwarded,
  `Retry-After` is honored, undici retry bodies are dumped, and non-retried
  responses rethrow the client's own error class.
- `Pacer#reset(key?)` and `Pacer#getState(key)` for introspection and manual
  state resets; pauses already in progress are not interrupted.
- `Pacer#runWithRetry(dispatch, view, opts)` — the client-agnostic retry loop
  behind `fetch` and every adapter — plus the exported `ResponseView`
  interface, so adapters for other clients can be built on the public API.
- README "Adapters" section and `reset` / `getState` documentation.

### Changed

- `PacerExhaustedError` is now generic (`PacerExhaustedError<R = Response>`)
  so adapters can attach their native response; `instanceof` narrowing from an
  `unknown` value yields `any` for `.response` (a TypeScript limitation for
  generic classes) — annotate the catch variable or helper to recover the
  precise type. The default keeps `Response`, so existing fetch code is
  unaffected.

## [0.1.1] — 2026-11-11

### Added

- `onRetry` observability callback (`pacer()` / `new Pacer()`): fired exactly
  once right before every retry with a `RetryInfo` payload —
  `{ key, status, attempt, delayMs, retryAfterMs }` (`attempt` counts the
  upcoming attempt, first retry = 2; `delayMs` includes jitter;
  `retryAfterMs` is the parsed `Retry-After` in ms or `null`). The
  `RetryInfo` type is exported. Callback exceptions propagate to the
  caller, matching `onStateChange` semantics.
- README: CI / MIT / Node ≥ 20 badges in the header; `onRetry` documented
  in the Options table and Example 2.

## [0.1.0] — 2026-11-11

Initial MVP.

### Added

- `pacer(fetchFn, opts)` wrapper: adaptive pacing from response headers
  (`RateLimit` / `RateLimit-Policy` IETF drafts 7–11, GitLab uncombined,
  OpenAI, Anthropic, generic `X-RateLimit-*` / Discord) plus `Retry-After`
  (delta-seconds and HTTP-date) handling.
- `Pacer` class with `schedule()` / `observe()` / `fetch()` for non-fetch and
  fetch-like clients.
- Per-key adaptive limiter: reservation-adjusted remaining, serialized
  decisions (internal mutex), multi-window pacing by the strictest window,
  pause-until-reset, `maxConcurrent`, static `initial` fallback.
- Retry policy: `retryOn` statuses, `maxRetries`, exact `Retry-After` waits or
  exponential 1s/2s/4s… backoff, full jitter, `PacerExhaustedError` with the
  attached response.
- Injectable `Clock`, `onStateChange` metrics hook, `key` bucketing,
  `maxWaitMs` liveness cap.
- 42 golden parser fixtures, unit/integration tests, dual ESM+CJS build.
