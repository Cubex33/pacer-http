import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRateLimitHeaders } from "../../src/parse/headers.js";
import { parseRetryAfter } from "../../src/parse/retryAfter.js";

interface HeadersFixture {
  name: string;
  category: string;
  target: "headers";
  headers: Record<string, string>;
  now: string;
  expected: null | {
    limit: number;
    remaining: number;
    reset: string | null;
    windows?: Array<{ limit: number; windowSec: number }>;
    unit?: string;
  };
}

interface RetryAfterFixture {
  name: string;
  category: string;
  target: "retry-after";
  value: string | null;
  now: string;
  expectedMs: number | null;
}

type Fixture = HeadersFixture | RetryAfterFixture;

const fixturesDir = fileURLToPath(new URL("../../src/parse/fixtures/", import.meta.url));
const files = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

const REQUIRED_CATEGORIES = [
  "github",
  "square",
  "discord",
  "gitlab",
  "openai",
  "anthropic",
  "ietf",
  "retry-after",
  "broken",
];

describe("golden fixture set", () => {
  it("contains at least 25 fixtures", () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it("covers every required family with at least 3 fixtures", () => {
    const counts = new Map<string, number>();
    for (const file of files) {
      const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;
      counts.set(fx.category, (counts.get(fx.category) ?? 0) + 1);
    }
    for (const category of REQUIRED_CATEGORIES) {
      expect(counts.get(category) ?? 0, `category ${category}`).toBeGreaterThanOrEqual(3);
    }
  });

  for (const file of files) {
    const fx = JSON.parse(readFileSync(join(fixturesDir, file), "utf8")) as Fixture;
    it(`${file} — ${fx.name}`, () => {
      const now = new Date(fx.now);
      if (fx.target === "retry-after") {
        expect(parseRetryAfter(fx.value, now)).toBe(fx.expectedMs);
        return;
      }
      const state = parseRateLimitHeaders(new Headers(fx.headers), now);
      const expected = fx.expected;
      if (expected === null) {
        expect(state).toBeNull();
        return;
      }
      expect(state).not.toBeNull();
      expect(state!.limit).toBe(expected.limit);
      expect(state!.remaining).toBe(expected.remaining);
      expect(state!.reset === null ? null : state!.reset.toISOString()).toBe(expected.reset);
      expect(state!.windows).toEqual(expected.windows ?? []);
      if (expected.unit === undefined) {
        expect(state!.unit).toBeUndefined();
      } else {
        expect(state!.unit).toBe(expected.unit);
      }
    });
  }
});
