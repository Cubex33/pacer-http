/**
 * Thrown when a retryable response (per `retryOn`, default 429) is still
 * returned after `maxRetries` retries. The offending response is attached so
 * caller code can inspect headers and decide what to do (give up, escalate,
 * schedule for later, ...).
 */
export class PacerExhaustedError extends Error {
  /** The last (rate-limited) response that exhausted the retry budget. */
  readonly response: Response;
  /** Total number of requests made, including the first one. */
  readonly attempts: number;

  constructor(response: Response, attempts: number) {
    super(`rate limit exhausted: HTTP ${response.status} after ${attempts} attempt(s)`);
    this.name = "PacerExhaustedError";
    this.response = response;
    this.attempts = attempts;
  }
}
