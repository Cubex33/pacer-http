import { describe, expect, it } from "vitest";
import { PacerExhaustedError } from "../../src/index.js";

describe("PacerExhaustedError", () => {
  it("describes fetch-shaped responses by status", () => {
    const err = new PacerExhaustedError(new Response("x", { status: 429 }), 4);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PacerExhaustedError");
    expect(err.message).toBe("rate limit exhausted: HTTP 429 after 4 attempt(s)");
    expect(err.response.status).toBe(429);
    expect(err.attempts).toBe(4);
  });

  it("describes statusCode-shaped responses (got / undici)", () => {
    const res = { statusCode: 503 } as unknown as Response;
    const err = new PacerExhaustedError(res, 2);
    expect(err.message).toBe("rate limit exhausted: HTTP 503 after 2 attempt(s)");
    expect(err.response).toBe(res); // the native response is attached untouched
  });
});
