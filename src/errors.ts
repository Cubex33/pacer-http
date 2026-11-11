/**
 * Thrown when a retryable response (per `retryOn`, default 429) is still
 * returned after `maxRetries` retries. The offending response is attached so
 * caller code can inspect headers and decide what to do (give up, escalate,
 * schedule for later, ...).
 *
 * `R` is the response type of the wrapped client: `Response` for fetch-shaped
 * clients (the default), `AxiosResponse` for the axios adapter, and so on.
 * Note that TypeScript narrows a generic class to `PacerExhaustedError<any>`
 * when the value being narrowed is `unknown` (as in a `catch` variable), so
 * `err.response` is `any` there; annotate the helper's return type or cast
 * (`e as PacerExhaustedError<Response>`) to recover the precise type.
 */
export class PacerExhaustedError<R = Response> extends Error {
  /** The last (rate-limited) response that exhausted the retry budget. */
  readonly response: R;
  /** Total number of requests made, including the first one. */
  readonly attempts: number;

  constructor(response: R, attempts: number) {
    // Works for every supported response shape: fetch/axios expose `status`,
    // got/undici expose `statusCode`.
    const { status, statusCode } = response as { status?: number; statusCode?: number };
    super(`rate limit exhausted: HTTP ${status ?? statusCode} after ${attempts} attempt(s)`);
    this.name = "PacerExhaustedError";
    this.response = response;
    this.attempts = attempts;
  }
}
