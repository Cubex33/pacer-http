import { describe, expect, expectTypeOf, it } from "vitest";
import axios, { type AxiosInstance, type AxiosResponse } from "axios";
import got, { type Response as GotResponse } from "got";
import { request as undiciRequest } from "undici";
import { wrapAxios, type PacedAxios } from "../../src/adapters/axios.js";
import { wrapGot, type GotFn, type PacedGot } from "../../src/adapters/got.js";
import {
  wrapUndici,
  type UndiciRequestOptions,
  type UndiciResponseData,
} from "../../src/adapters/undici.js";
import { PacerExhaustedError, type PacerOptions, type RateLimitState } from "../../src/index.js";
import { Pacer, type ResponseView } from "../../src/pacer.js";

describe("adapter types", () => {
  it("wrapAxios takes an instance and returns the full shortcut surface", () => {
    expectTypeOf(wrapAxios).parameter(0).toEqualTypeOf<AxiosInstance>();
    expectTypeOf(wrapAxios).parameter(1).toEqualTypeOf<PacerOptions | undefined>();

    const api: PacedAxios = wrapAxios(axios.create());
    expectTypeOf(api).toBeFunction();
    for (const method of ["request", "get", "post", "put", "patch", "delete", "head"] as const) {
      expectTypeOf(api[method]).toBeFunction();
    }
    // (never invoked: only the declared types are asserted)
    const call = () => api<{ id: number }>("/items");
    const get = () => api.get<{ id: number }>("/items");
    const post = () => api.post<{ id: number }>("/items", { id: 1 });
    expectTypeOf(call).returns.toEqualTypeOf<Promise<AxiosResponse<{ id: number }, unknown>>>();
    expectTypeOf(get).returns.toEqualTypeOf<Promise<AxiosResponse<{ id: number }, unknown>>>();
    expectTypeOf(post).returns.toEqualTypeOf<Promise<AxiosResponse<{ id: number }, unknown>>>();
  });

  it("wrapUndici mirrors undici's request() signature", () => {
    const pacedRequest = wrapUndici(undiciRequest);
    expectTypeOf(pacedRequest).parameter(0).toEqualTypeOf<string | URL>();
    expectTypeOf(pacedRequest).parameter(1).toEqualTypeOf<UndiciRequestOptions | undefined>();
    const call = () => pacedRequest("https://example.com", { method: "GET" });
    expectTypeOf(call).returns.toEqualTypeOf<Promise<UndiciResponseData>>();
  });

  it("wrapGot accepts got and got.extend() instances", () => {
    expectTypeOf(got).toMatchTypeOf<GotFn>();
    const extended = got.extend({ headers: { "x-custom": "yes" } });
    expectTypeOf(extended).toMatchTypeOf<GotFn>();

    const paced: PacedGot = wrapGot(got);
    const strict = () => paced("https://example.com");
    const text = () => paced("https://example.com", { responseType: "text" });
    const json = () => paced<{ id: number }>("https://example.com", { responseType: "json" });
    const buffer = () => paced("https://example.com", { responseType: "buffer" });
    expectTypeOf(strict).returns.toEqualTypeOf<Promise<GotResponse<string>>>();
    expectTypeOf(text).returns.toEqualTypeOf<Promise<GotResponse<string>>>();
    expectTypeOf(json).returns.toEqualTypeOf<Promise<GotResponse<{ id: number }>>>();
    expectTypeOf(buffer).returns.toEqualTypeOf<Promise<GotResponse<Uint8Array>>>();
  });

  it("Pacer exposes reset/getState and the runWithRetry extension point", () => {
    const p = new Pacer();
    expectTypeOf(p.reset).parameter(0).toEqualTypeOf<string | undefined>();
    expectTypeOf(p.getState).parameter(0).toEqualTypeOf<string>();
    expectTypeOf(p.getState).returns.toEqualTypeOf<RateLimitState | undefined>();
    expectTypeOf(p.runWithRetry).toBeFunction();
    const run = () =>
      p.runWithRetry(
        () => Promise.resolve(new Response("ok")),
        (res) => ({ status: res.status, getHeader: (name) => res.headers.get(name) }),
        { key: "https://example.com" },
      );
    expectTypeOf(run).returns.toEqualTypeOf<Promise<Response>>();
  });

  it("ResponseView declares the adapter contract", () => {
    const view: ResponseView = {
      status: 200,
      getHeader: (name: string) => (name === "retry-after" ? "1" : null),
      error: undefined,
      discard: () => {},
    };
    expectTypeOf<ResponseView["status"]>().toEqualTypeOf<number>();
    expectTypeOf<ResponseView["getHeader"]>().toEqualTypeOf<(name: string) => string | null>();
    expectTypeOf<ResponseView["error"]>().toEqualTypeOf<unknown>();
    expectTypeOf<ResponseView["discard"]>().toEqualTypeOf<(() => void) | undefined>();
    expect(view.getHeader("retry-after")).toBe("1");
  });

  it("PacerExhaustedError is generic and keeps instanceof usable from unknown", () => {
    const axiosLike = { status: 429 } as unknown as AxiosResponse;
    const err = new PacerExhaustedError<AxiosResponse>(axiosLike, 2);
    expectTypeOf(err.response).toEqualTypeOf<AxiosResponse>();
    expectTypeOf(err.attempts).toEqualTypeOf<number>();
    expect(err.attempts).toBe(2);

    // TypeScript narrows a generic class to `PacerExhaustedError<any>` when
    // the narrowed value is `unknown` (e.g. a catch variable)…
    const narrowed = (e: unknown) => (e instanceof PacerExhaustedError ? e.response : null);
    expectTypeOf<ReturnType<typeof narrowed>>().toBeAny();
    expect(narrowed(err)).not.toBeNull();
    // …and an explicit return annotation recovers the precise response type.
    const typed = (e: unknown): Response | null =>
      e instanceof PacerExhaustedError ? e.response : null;
    expectTypeOf<ReturnType<typeof typed>>().toEqualTypeOf<Response | null>();
    expect(typed(err)).not.toBeNull(); // the attached axios response survives
  });
});
