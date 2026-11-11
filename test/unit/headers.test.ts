import { describe, expect, it } from "vitest";
import { parseRateLimitHeaders, parseSfList, type HeadersLike } from "../../src/parse/headers.js";

describe("parseSfList", () => {
  it("parses strings, integers, decimals, tokens, booleans and byte sequences", () => {
    const items = parseSfList('"a", 1, 1.5, tok, ?1, :aGk:');
    expect(items).not.toBeNull();
    expect(items!.map((i) => i.value)).toEqual(["a", 1, 1.5, "tok", true, "aGk"]);
  });

  it("parses parameters including bare (boolean) parameters", () => {
    const items = parseSfList('"id";q=10;w=60;pk');
    expect(items).toEqual([
      {
        value: "id",
        params: new Map<string, number | string | boolean>([
          ["q", 10],
          ["w", 60],
          ["pk", true],
        ]),
      },
    ]);
  });

  it("accepts SP-separated and comma-separated lists", () => {
    const items = parseSfList('"a" ;r=1 , "b";r=2');
    expect(items!.map((i) => i.value)).toEqual(["a", "b"]);
  });

  it("rejects malformed lists", () => {
    expect(parseSfList("")).toBeNull();
    expect(parseSfList('"a",')).toBeNull(); // trailing comma
    expect(parseSfList('"a"x')).toBeNull(); // junk after item
    expect(parseSfList('"unterminated')).toBeNull(); // unterminated string
    expect(parseSfList('"a";=1')).toBeNull(); // param without key
    expect(parseSfList('"a";q=1;q=2')).toBeNull(); // duplicate param
    expect(parseSfList("1e3")).toBeNull(); // not an SF number
    expect(parseSfList('"a";q=1.2345')).toBeNull(); // >3 fraction digits
    expect(parseSfList('"\\a"')).toBeNull(); // invalid escape
    expect(parseSfList(":ab")).toBeNull(); // unterminated byte sequence
    expect(parseSfList("?2")).toBeNull(); // invalid boolean
  });

  it("accepts escaped quotes and backslashes in strings", () => {
    const items = parseSfList('"a\\"b\\\\c"');
    expect(items![0]!.value).toBe('a"b\\c');
  });
});

describe("parseRateLimitHeaders input shapes", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  it("accepts a plain record", () => {
    const state = parseRateLimitHeaders(
      {
        "x-ratelimit-limit": "60",
        "x-ratelimit-remaining": "59",
        "x-ratelimit-reset": "1794398460",
      } satisfies HeadersLike,
      now,
    );
    expect(state).toEqual({
      limit: 60,
      remaining: 59,
      reset: new Date("2026-11-11T12:01:00Z"),
      windows: [],
      unit: undefined,
    });
  });

  it("accepts a getter object (e.g. Node's res.headers)", () => {
    const state = parseRateLimitHeaders(
      {
        get: (name: string) =>
          name === "x-ratelimit-remaining" ? "0" : name === "x-ratelimit-reset" ? "30" : null,
      } satisfies HeadersLike,
      now,
    );
    expect(state).toMatchObject({ remaining: 0, reset: new Date(now.getTime() + 30_000) });
  });

  it("accepts a Response", () => {
    const res = new Response("x", {
      headers: { "x-ratelimit-limit": "10", "x-ratelimit-remaining": "9" },
    });
    const state = parseRateLimitHeaders(res, now);
    expect(state).toMatchObject({ limit: 10, remaining: 9, reset: null });
  });

  it("accepts `now` as epoch milliseconds", () => {
    const state = parseRateLimitHeaders(
      { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "10" },
      now.getTime(),
    );
    expect(state!.reset!.getTime()).toBe(now.getTime() + 10_000);
  });

  it("returns null for null-ish input", () => {
    expect(parseRateLimitHeaders({}, now)).toBeNull();
  });
});

describe("parseRateLimitHeaders family precedence", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  it("prefers IETF over legacy families", () => {
    const state = parseRateLimitHeaders(
      {
        ratelimit: '"example";r=7;t=3',
        "x-ratelimit-limit": "999",
        "x-ratelimit-remaining": "998",
        "x-ratelimit-reset": "1794398460",
      },
      now,
    );
    expect(state).toMatchObject({ limit: -1, remaining: 7 });
  });

  it("prefers GitLab uncombined over OpenAI / Anthropic / generic X", () => {
    const state = parseRateLimitHeaders(
      {
        "ratelimit-limit": "600",
        "ratelimit-remaining": "42",
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
      },
      now,
    );
    expect(state).toMatchObject({ limit: 600, remaining: 42 });
  });

  it("prefers OpenAI over Anthropic and generic X", () => {
    const state = parseRateLimitHeaders(
      {
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "90",
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
      },
      now,
    );
    expect(state).toMatchObject({ limit: 100, remaining: 90, unit: "requests" });
  });

  it("prefers Anthropic over generic X", () => {
    const state = parseRateLimitHeaders(
      {
        "anthropic-ratelimit-requests-limit": "50",
        "anthropic-ratelimit-requests-remaining": "40",
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
      },
      now,
    );
    expect(state).toMatchObject({ limit: 50, remaining: 40, unit: "requests" });
  });

  it("garbage in a winning family yields null even when a legacy family is valid", () => {
    const state = parseRateLimitHeaders(
      {
        ratelimit: "limit=10, remaining=-1",
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
      },
      now,
    );
    expect(state).toBeNull();
  });

  it("malformed IETF structured fields fall back to the legacy family", () => {
    const state = parseRateLimitHeaders(
      {
        ratelimit: '"a";r=1;t=1,',
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
      },
      now,
    );
    expect(state).toMatchObject({ limit: 10, remaining: 9 });
  });

  it("reset-after does not rescue a garbage generic family", () => {
    const state = parseRateLimitHeaders(
      {
        "x-ratelimit-limit": "abc",
        "x-ratelimit-remaining": "1",
        "x-ratelimit-reset-after": "1.5",
      },
      now,
    );
    expect(state).toBeNull();
  });
});

describe("parseRateLimitHeaders reset heuristics", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  it("treats large numbers as epoch milliseconds", () => {
    const state = parseRateLimitHeaders(
      { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "1794398400000" },
      now,
    );
    expect(state!.reset!.getTime()).toBe(1794398400000);
  });

  it("treats medium numbers as epoch seconds and small numbers as delta seconds", () => {
    const epochS = parseRateLimitHeaders(
      { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "1794398460" },
      now,
    );
    expect(epochS!.reset!.getTime()).toBe(1794398460000);
    const delta = parseRateLimitHeaders(
      { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "10" },
      now,
    );
    expect(delta!.reset!.getTime()).toBe(now.getTime() + 10_000);
  });

  it("rejects NaN and negative reset values as garbage", () => {
    expect(
      parseRateLimitHeaders({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": "NaN" }, now),
    ).toBeNull();
    expect(
      parseRateLimitHeaders({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": "-1" }, now),
    ).toBeNull();
  });
});

describe("parseRateLimitHeaders edge coverage", () => {
  const now = new Date("2026-11-11T12:00:00Z");

  it("rejects a structured-field item that starts with an invalid character", () => {
    expect(parseSfList("!x")).toBeNull();
    expect(parseSfList("+1")).toBeNull();
    expect(parseRateLimitHeaders({ ratelimit: "!x" } satisfies HeadersLike, now)).toBeNull();
  });

  it("accepts SP-separated structured-field list items", () => {
    const items = parseSfList('"a";r=1 "b";r=2');
    expect(items!.map((i) => i.value)).toEqual(["a", "b"]);
  });

  it("parses OpenAI duration strings with hours", () => {
    const state = parseRateLimitHeaders(
      {
        "x-ratelimit-remaining-requests": "99",
        "x-ratelimit-reset-requests": "1h",
      } satisfies HeadersLike,
      now,
    );
    expect(state).toMatchObject({
      limit: -1,
      remaining: 99,
      reset: new Date(now.getTime() + 3_600_000),
      unit: "requests",
    });
  });

  it("ignores a garbage Discord reset-after and keeps the epoch reset", () => {
    const epoch = Math.ceil((now.getTime() + 60_000) / 1000);
    const state = parseRateLimitHeaders(
      {
        "x-ratelimit-limit": "10",
        "x-ratelimit-remaining": "9",
        "x-ratelimit-reset": String(epoch),
        "x-ratelimit-reset-after": "junk",
      } satisfies HeadersLike,
      now,
    );
    expect(state!.reset!.getTime()).toBe(epoch * 1000);
  });

  it("ignores a RateLimit-Policy whose items are neither identifiers nor limits", () => {
    const state = parseRateLimitHeaders(
      {
        ratelimit: '"a";r=5;t=30',
        "ratelimit-policy": "-5;w=1",
      } satisfies HeadersLike,
      now,
    );
    expect(state).toMatchObject({
      limit: -1,
      remaining: 5,
      reset: new Date(now.getTime() + 30_000),
      windows: [],
    });
  });

  it("treats draft-7 text with remaining above limit as garbage", () => {
    expect(
      parseRateLimitHeaders({ ratelimit: "limit=10, remaining=20" } satisfies HeadersLike, now),
    ).toBeNull();
  });

  it("breaks equal-remaining ties towards the service limit that has a reset", () => {
    const state = parseRateLimitHeaders(
      { ratelimit: '"a";r=5,"b";r=5;t=10' } satisfies HeadersLike,
      now,
    );
    expect(state).toMatchObject({
      remaining: 5,
      reset: new Date(now.getTime() + 10_000),
    });
  });

  it("reports reset-only IETF service limits without a remaining budget", () => {
    const state = parseRateLimitHeaders({ ratelimit: '"burst";t=30' } satisfies HeadersLike, now);
    expect(state).toEqual({
      limit: -1,
      remaining: -1,
      reset: new Date(now.getTime() + 30_000),
      windows: [],
      unit: undefined,
    });
  });

  it("returns null for header input that is not an object", () => {
    expect(parseRateLimitHeaders(42 as unknown as HeadersLike, now)).toBeNull();
    expect(parseRateLimitHeaders("ratelimit: 1" as unknown as HeadersLike, now)).toBeNull();
  });
});
