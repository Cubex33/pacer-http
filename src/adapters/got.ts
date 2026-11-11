/**
 * got adapter — do NOT import got at runtime from here: this module must
 * stay dependency-free. Only the types are referenced (`import type` is
 * erased at build time), the client itself is injected by the caller.
 */
import type {
  OptionsOfBufferResponseBody,
  OptionsOfJSONResponseBody,
  OptionsOfTextResponseBody,
  Response,
  StrictOptions,
} from "got";
import { resolvePacerOptions } from "../limiter/limiter.js";
import { Pacer, type ResponseView } from "../pacer.js";
import type { PacerOptions } from "../types.js";
import { headerGetter } from "./headers.js";

/** Options the wrapper forwards: anything except `resolveBodyOnly` forms (the wrapper always resolves the full response). */
export type GotWrapOptions =
  | StrictOptions
  | OptionsOfTextResponseBody
  | OptionsOfJSONResponseBody
  | OptionsOfBufferResponseBody;

/**
 * The callable surface of `got` the wrapper uses — `got` itself and
 * `got.extend()` instances both satisfy it.
 */
export interface GotFn {
  (url: string | URL, options?: StrictOptions): Promise<Response<string>>;
  (url: string | URL, options?: OptionsOfTextResponseBody): Promise<Response<string>>;
  <T = unknown>(url: string | URL, options?: OptionsOfJSONResponseBody): Promise<Response<T>>;
  (url: string | URL, options?: OptionsOfBufferResponseBody): Promise<Response<Uint8Array>>;
}

/**
 * The paced function returned by {@link wrapGot}: `(url, options?)`
 * resolving got's native response.
 *
 * The returned promise does **not** carry got's `.json()` / `.text()` /
 * `.buffer()` shortcuts (they re-configure the pending request, which does
 * not compose with retries) — pass `responseType: "json"` (or `"text"` /
 * `"buffer"`) in the options and read `response.body` instead.
 */
export interface PacedGot {
  (url: string | URL, options?: StrictOptions): Promise<Response<string>>;
  (url: string | URL, options?: OptionsOfTextResponseBody): Promise<Response<string>>;
  <T = unknown>(url: string | URL, options?: OptionsOfJSONResponseBody): Promise<Response<T>>;
  (url: string | URL, options?: OptionsOfBufferResponseBody): Promise<Response<Uint8Array>>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Wraps `got` (or a `got.extend()` instance) with adaptive client-side rate
 * limiting.
 *
 * Every response's `RateLimit` / `X-RateLimit-*` headers feed the pacer and
 * requests that would overdraw the advertised budget wait until the
 * advertised reset; statuses in `retryOn` (default `[429]`) are retried
 * after exactly `Retry-After` (+ jitter), then {@link PacerExhaustedError}
 * carries the native got response. Non-retryable error statuses rethrow
 * got's own `HTTPError` unchanged, so `throwHttpErrors` semantics are
 * preserved.
 *
 * Disable got's built-in retry (`retry: { limit: 0 }`) when wrapping: got
 * would retry the same 429 itself, doubling the request count. Keep it only
 * if you deliberately want got to handle non-rate-limit statuses.
 *
 * `options.signal` aborts pacing waits and is forwarded to got. Bucket keys
 * come from the URL (a custom `key` option receives the URL and the options
 * as `init`).
 *
 * @example
 * ```ts
 * import got from "got";
 * import { wrapGot } from "pacer-http/got";
 *
 * const paced = wrapGot(got);
 * const res = await paced("https://api.github.com/rate_limit", {
 *   retry: { limit: 0 },
 * });
 * console.log(res.statusCode, res.headers["x-ratelimit-remaining"]);
 * ```
 */
export function wrapGot(gotFn: GotFn, opts: PacerOptions = {}): PacedGot {
  const engine = new Pacer(opts);
  const { keyFn } = resolvePacerOptions(opts);

  const paced = (url: string | URL, options?: GotWrapOptions): Promise<Response> => {
    // Responses got delivered as a thrown HTTPError: the engine needs the
    // response to decide on a retry, but a non-retried one must rethrow the
    // original error to preserve got's throwHttpErrors semantics.
    const thrownFor = new WeakMap<object, unknown>();
    const dispatch = async (): Promise<Response> => {
      try {
        return await gotFn(url, options as StrictOptions);
      } catch (err) {
        const response = isObject(err) ? err.response : undefined;
        if (isObject(response)) {
          thrownFor.set(response, err);
          return response as unknown as Response;
        }
        throw err; // network errors, timeouts, cancellations, … propagate
      }
    };
    const view = (res: Response): ResponseView => ({
      status: res.statusCode,
      getHeader: headerGetter(res.headers),
      error: thrownFor.get(res),
    });
    return engine.runWithRetry(dispatch, view, {
      key: keyFn(typeof url === "string" ? url : url.href, options as RequestInit),
      signal: options?.signal ?? undefined,
    });
  };
  return paced as PacedGot;
}
