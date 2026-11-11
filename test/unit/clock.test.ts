import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbortError, SystemClock } from "../../src/limiter/clock.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAbortError", () => {
  it("uses DOMException when it is available", () => {
    const err = createAbortError();
    expect(err).toBeInstanceOf(DOMException);
    expect(err.name).toBe("AbortError");
  });

  it("falls back to a plain Error when DOMException is missing", () => {
    vi.stubGlobal("DOMException", undefined);
    const err = createAbortError();
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AbortError");
  });
});

describe("SystemClock.sleep", () => {
  it("rejects immediately, without arming a timer, when the signal is already aborted", async () => {
    const clock = new SystemClock();
    const controller = new AbortController();
    controller.abort();
    const handle = clock.sleep(60_000, { signal: controller.signal });
    await expect(handle.promise).rejects.toMatchObject({ name: "AbortError" });
  });

  it("cancel() resolves early and a later cancel is a no-op", async () => {
    const clock = new SystemClock();
    const handle = clock.sleep(60_000);
    handle.cancel();
    handle.cancel(); // already settled — must not throw or re-resolve
    await expect(handle.promise).resolves.toBeUndefined();
  });
});
