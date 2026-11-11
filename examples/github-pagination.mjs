// Demo: GitHub-style pagination through pacer-http — not a single 429 and
// not a single manual sleep. A local mock server stands in for
// api.github.com (same X-RateLimit-* header family), so the demo runs fully
// offline. Run `npm run build` first, then `node examples/github-pagination.mjs`.

import { createServer } from "node:http";
import { pacer } from "../dist/index.js";

/** Bucket the server enforces; GitHub's real core bucket is 60/hour. */
const LIMIT = 5;
const WINDOW_MS = 2_000;
const PAGES = 6;
const ITEMS_PER_PAGE = 10;

/* ------------------------------------------------------------------ *
 * A GitHub-shaped server: X-RateLimit-* on every response, 429 (never
 * reached in this demo) once the window is overdrawn.
 * ------------------------------------------------------------------ */

const stats = { requests: 0, throttled: 0 };
let windowStart = Date.now();
let hitsInWindow = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now; // window rolled over
    hitsInWindow = 0;
  }

  stats.requests++;
  hitsInWindow++;
  const remaining = LIMIT - hitsInWindow;

  if (remaining < 0) {
    stats.throttled++;
    res.writeHead(429, {
      "x-ratelimit-limit": String(LIMIT),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.ceil((windowStart + WINDOW_MS) / 1000)),
      "retry-after": String(Math.ceil((windowStart + WINDOW_MS - now) / 1000)),
    });
    res.end(JSON.stringify({ message: "You have exceeded a secondary rate limit" }));
    return;
  }

  const page = Number(url.searchParams.get("page") ?? "1");
  const hasNext = page < PAGES;
  res.writeHead(200, {
    "content-type": "application/json",
    "x-ratelimit-limit": String(LIMIT),
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(Math.ceil((windowStart + WINDOW_MS) / 1000)),
    ...(hasNext ? { link: `<${url.pathname}?page=${page + 1}>; rel="next"` } : {}),
  });
  res.end(
    JSON.stringify({
      page,
      items: Array.from({ length: ITEMS_PER_PAGE }, (_, i) => `item-${page}-${i}`),
    }),
  );
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------ *
 * The client: plain fetch + pacer. No SDK, no sleeps, no retry code.
 * ------------------------------------------------------------------ */

const fetch = pacer(globalThis.fetch, { maxConcurrent: 2 });

function nextLink(header) {
  const match = /<([^>]+)>;\s*rel="next"/.exec(header ?? "");
  return match ? `${base}${match[1]}` : null;
}

const t0 = performance.now();
let url = `${base}/items?page=1`;
let pages = 0;
while (url !== null) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`unexpected HTTP ${res.status}`);
  await res.json(); // consume the body so the connection is reusable
  pages++;
  console.log(
    `page ${String(pages).padStart(2)} ` +
      `t+${String(Math.round(performance.now() - t0)).padStart(4)}ms  ` +
      `x-ratelimit-remaining=${res.headers.get("x-ratelimit-remaining")}`,
  );
  url = nextLink(res.headers.get("link"));
}

server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));

console.log(
  `\n${pages} pages fetched with ${stats.requests} requests, ` +
    `${stats.throttled} throttled (429) responses, zero manual sleeps.`,
);
if (stats.throttled !== 0) {
  throw new Error("demo failed: the server throttled at least one request");
}
