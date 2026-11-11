import { describe, expect, it } from "vitest";
import { parseRetryAfter } from "../../src/parse/retryAfter.js";

const NOW = new Date("2026-11-11T12:00:00Z");

describe("parseRetryAfter", () => {
  it("parses delay-seconds", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter("0", NOW)).toBe(0);
    expect(parseRetryAfter("007", NOW)).toBe(7_000);
    expect(parseRetryAfter("  30  ", NOW)).toBe(30_000);
  });

  it("parses HTTP dates and clamps past dates to 0", () => {
    expect(parseRetryAfter("Wed, 11 Nov 2026 12:00:30 GMT", NOW)).toBe(30_000);
    expect(parseRetryAfter("Wed, 11 Nov 2026 11:59:30 GMT", NOW)).toBe(0);
    expect(parseRetryAfter("2026-11-11T12:00:45Z", NOW)).toBe(45_000);
  });

  it("returns null for absent, empty or invalid values", () => {
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter("", NOW)).toBeNull();
    expect(parseRetryAfter("   ", NOW)).toBeNull();
    expect(parseRetryAfter("soon", NOW)).toBeNull();
    expect(parseRetryAfter("1.5", NOW)).toBeNull();
    expect(parseRetryAfter("-5", NOW)).toBeNull();
  });

  it("accepts `now` as epoch milliseconds", () => {
    expect(parseRetryAfter("10", NOW.getTime())).toBe(10_000);
    expect(parseRetryAfter("2026-11-11T12:00:01Z", NOW.getTime())).toBe(1_000);
  });

  it("defaults `now` to the current time", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("junk")).toBeNull();
    const delta = parseRetryAfter(new Date(Date.now() + 60_000).toUTCString());
    expect(delta).not.toBeNull();
    expect(delta!).toBeGreaterThan(0);
    expect(delta!).toBeLessThanOrEqual(60_000);
  });
});
