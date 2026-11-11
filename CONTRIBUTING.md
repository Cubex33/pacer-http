# Contributing to pacer-http

Thanks for helping! This project is small on purpose: zero runtime
dependencies, one job done well.

## Setup

```bash
git clone <your-fork>
cd pacer-http
npm install
npm test
```

Node 20 or 22 is required (see `engines` in `package.json`).

## Workflow

Before opening a PR, all of these must be green:

```bash
npm run lint         # eslint + prettier --check
npm run typecheck    # tsc --noEmit
npm test             # unit + integration (localhost only)
npm run test:coverage # lines coverage of src/ must stay >= 90%
npm run build         # dual ESM/CJS build into dist/
```

CI (`.github/workflows/ci.yml`) runs the same on Node 20 and 22.

## Adding a provider fixture

The parser is pinned by golden files in `src/parse/fixtures/`. To support a
new response format:

1. Capture the **real** headers (redact anything sensitive).
2. Add a JSON file to `src/parse/fixtures/`:

   ```json
   {
     "name": "Provider / short description",
     "category": "provider-name",
     "target": "headers",
     "headers": { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" },
     "now": "2026-11-11T12:00:00.000Z",
     "expected": {
       "limit": 60,
       "remaining": 59,
       "reset": "2026-11-11T12:01:00.000Z",
       "windows": []
     }
   }
   ```

   - `now` anchors relative values (delta-second resets, `t=` parameters);
     expected `reset` is an absolute ISO timestamp.
   - `expected: null` asserts the headers are garbage (no throw, no state).
   - For `Retry-After` cases use `"target": "retryAfter"` with `"value"` and
     `"expectedMs"`.

3. If the family is new, extend `src/parse/headers.ts` and add it to the
   priority list in `parseRateLimitHeaders` (documented in its JSDoc). Run
   `npm test` — `test/unit/fixtures.test.ts` picks the file up automatically
   and fails loudly if the parser disagrees.

## Adding a limiter behavior

Behavioral tests live in `test/unit/limiter.test.ts` and use fake timers —
no real sleeps anywhere. Integration scenarios run against a programmable
`node:http` server on `127.0.0.1` (`test/integration/server.test.ts`); never
against the public internet.

## Conventions

- TypeScript strict mode; no `any` in `src/`.
- No new runtime dependencies without a very good reason — vendoring small
  parsing logic is preferred; the header parser is intentionally homegrown.
- Keep the public API surface small: everything exported from `src/index.ts`
  is contract; everything else may change.

## Reporting bugs

Use the bug report template — attach the **raw response headers** (the
minimal reproducible set) so the failure can be pinned as a fixture.
