import { describe, expect, expectTypeOf, it } from "vitest";
import {
  Pacer,
  PacerExhaustedError,
  SystemClock,
  pacer,
  parseRateLimitHeaders,
  parseRetryAfter,
  type Clock,
  type HeadersLike,
  type PacerJitter,
  type PacerOptions,
  type RateLimitState,
  type RateLimitWindow,
  type RetryInfo,
  type ScheduleOptions,
  type SleepHandle,
  type TokenQuota,
} from "../../src/index.js";

describe("public API types", () => {
  it("pacer wraps a fetch-compatible function", () => {
    expectTypeOf(pacer).toBeFunction();
    expectTypeOf(pacer).parameter(0).toEqualTypeOf<typeof fetch>();
    expectTypeOf(pacer).parameter(1).toEqualTypeOf<PacerOptions | undefined>();
    expectTypeOf<ReturnType<typeof pacer>>().toEqualTypeOf<typeof fetch>();
  });

  it("Pacer exposes schedule/observe/fetch", () => {
    const p = new Pacer();
    expectTypeOf(p.schedule).toBeFunction();
    expectTypeOf(p.observe).toBeFunction();
    expectTypeOf(p.fetch).toBeFunction();
    expectTypeOf<Pacer["observe"]>().parameters.toEqualTypeOf<[res: Response, key?: string]>();
    const result: Promise<number> = p.schedule(() => Promise.resolve(42));
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();
  });

  it("schedule options carry key, signal and the token-cost request context", () => {
    expectTypeOf<ScheduleOptions>().toEqualTypeOf<{
      key?: string;
      signal?: AbortSignal;
      url?: string;
      init?: RequestInit;
    }>();
  });

  it("PacerExhaustedError carries the response and the attempt count", () => {
    const err = new PacerExhaustedError(new Response("x"), 3);
    expectTypeOf(err).toMatchTypeOf<Error>();
    expectTypeOf(err.response).toEqualTypeOf<Response>();
    expectTypeOf(err.attempts).toEqualTypeOf<number>();
    expect(err).toBeInstanceOf(Error);
  });

  it("RateLimitState, windows and token quotas are fully typed", () => {
    expectTypeOf<RateLimitWindow>().toEqualTypeOf<{
      limit: number;
      windowSec: number;
    }>();
    expectTypeOf<TokenQuota>().toEqualTypeOf<{
      limit: number;
      remaining: number;
      reset: Date | null;
    }>();
    expectTypeOf<RateLimitState>().toEqualTypeOf<{
      limit: number;
      remaining: number;
      reset: Date | null;
      windows: RateLimitWindow[];
      unit?: string;
      tokens?: TokenQuota;
    }>();
  });

  it("PacerOptions lists every documented knob", () => {
    expectTypeOf<PacerOptions>().toEqualTypeOf<{
      initial?: { limit: number; windowMs: number };
      maxConcurrent?: number;
      retryOn?: number[];
      maxRetries?: number;
      jitter?: PacerJitter;
      key?: (url: string, init?: RequestInit) => string;
      maxWaitMs?: number;
      shouldPause?: (s: RateLimitState) => boolean;
      tokenCost?: number | ((url: string, init?: RequestInit) => number);
      shouldPauseTokens?: (q: TokenQuota) => boolean;
      onStateChange?: (key: string, s: RateLimitState | null) => void;
      onRetry?: (info: RetryInfo) => void;
      clock?: Clock;
    }>();
    expectTypeOf<PacerJitter>().toEqualTypeOf<"none" | "full">();
  });

  it("RetryInfo carries the retry payload", () => {
    expectTypeOf<RetryInfo>().toEqualTypeOf<{
      key: string;
      status: number;
      attempt: number;
      delayMs: number;
      retryAfterMs: number | null;
    }>();
  });

  it("header parsers expose their contracts", () => {
    expectTypeOf(parseRateLimitHeaders).parameters.toEqualTypeOf<
      [headers: HeadersLike, now?: Date | number]
    >();
    expectTypeOf(parseRateLimitHeaders).returns.toEqualTypeOf<RateLimitState | null>();
    expectTypeOf(parseRetryAfter).parameters.toEqualTypeOf<
      [value: string | null | undefined, now?: Date | number]
    >();
    expectTypeOf(parseRetryAfter).returns.toEqualTypeOf<number | null>();
  });

  it("Clock is injectable and SystemClock satisfies it", () => {
    const clock: Clock = new SystemClock();
    expectTypeOf<SystemClock>().toMatchTypeOf<Clock>();
    expectTypeOf(clock.now()).toEqualTypeOf<Date>();
    const handle: SleepHandle = clock.sleep(100);
    expectTypeOf(handle.promise).toEqualTypeOf<Promise<void>>();
    expectTypeOf(handle.cancel).toBeFunction();
  });
});
