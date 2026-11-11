# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
