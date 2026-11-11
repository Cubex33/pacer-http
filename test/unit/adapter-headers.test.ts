import { describe, expect, it } from "vitest";
import { headerGetter } from "../../src/adapters/headers.js";

describe("headerGetter (adapter header normalization)", () => {
  it("uses .get when the headers object has one (AxiosHeaders v1 / fetch Headers)", () => {
    const store = new Map<string, string | number>([
      ["x-ratelimit-remaining", "42"],
      ["retry-after", "7"],
      ["numeric", 5],
    ]);
    const get = headerGetter({ get: (name: string) => store.get(name) ?? null });
    expect(get("x-ratelimit-remaining")).toBe("42");
    expect(get("X-RateLimit-Remaining")).toBe("42"); // case-insensitive
    expect(get("retry-after")).toBe("7");
    expect(get("numeric")).toBe("5"); // AxiosHeaders can hold non-strings
    expect(get("missing")).toBeNull();
  });

  it("lowercases plain records (axios v0 / got / undici headers)", () => {
    const get = headerGetter({
      "X-RateLimit-Limit": "10",
      "X-RateLimit-Remaining": "3",
      "x-ratelimit-reset": "1760000000",
    });
    expect(get("x-ratelimit-limit")).toBe("10");
    expect(get("X-RATELIMIT-REMAINING")).toBe("3");
    expect(get("x-ratelimit-reset")).toBe("1760000000");
    expect(get("retry-after")).toBeNull();
  });

  it("joins array values and skips undefined ones", () => {
    const get = headerGetter({ "retry-after": ["1", "2"], absent: undefined });
    expect(get("retry-after")).toBe("1, 2");
    expect(get("absent")).toBeNull();
  });

  it("returns null for everything when headers are not an object", () => {
    for (const headers of [null, undefined, "x", 42]) {
      const get = headerGetter(headers);
      expect(get("retry-after")).toBeNull();
    }
  });
});
