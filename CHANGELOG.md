# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
