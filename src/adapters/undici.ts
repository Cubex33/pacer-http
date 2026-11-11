/**
 * undici adapter — do NOT import undici at runtime from here: this module
 * must stay dependency-free. Only the types are referenced (`import type`
 * is erased at build time), the client itself is injected by the caller.
 */
import type { request } from "undici";
import { resolvePacerOptions } from "../limiter/limiter.js";
import { Pacer, type ResponseView } from "../pacer.js";
import type { PacerOptions } from "../types.js";
import { headerGetter } from "./headers.js";

/** Options accepted by undici's `request()` (dispatcher, method, headers, signal, …). */
export type UndiciRequestOptions = Parameters<typeof request>[1];
/** undici's native response object: `{ statusCode, statusText, headers, body, trailers }`. */
export type UndiciResponseData = Awaited<ReturnType<typeof request>>;

/**
 * The paced `request()` returned by {@link wrapUndici}: same call shape as
 * undici's `request` (minus the legacy `UrlObject` form), resolving undici's
 * native response.
 */
export interface PacedUndiciRequest {
  (url: string | URL, options?: UndiciRequestOptions): Promise<UndiciResponseData>;
}

/**
 * Wraps undici's `request()` with adaptive client-side rate limiting.
 *
 * Every response's `RateLimit` / `X-RateLimit-*` headers feed the pacer and
 * requests that would overdraw the advertised budget wait until the
 * advertised reset; statuses in `retryOn` (default `[429]`) are retried
 * after exactly `Retry-After` (+ jitter), then {@link PacerExhaustedError}
 * carries the native undici response. Responses discarded for a retry have
 * their body dumped, so the connection can be reused.
 *
 * `options.signal` aborts pacing waits and is forwarded to undici. Bucket
 * keys come from the URL (a custom `key` option receives the URL string and
 * the options as `init`).
 *
 * Note: `pacer(undici.fetch)` (the fetch-shaped API) also works without
 * this adapter; `wrapUndici` exists for undici's `request()` API.
 *
 * @example
 * ```ts
 * import { request } from "undici";
 * import { wrapUndici } from "pacer-http/undici";
 *
 * const pacedRequest = wrapUndici(request);
 * const { statusCode, body } = await pacedRequest("https://api.github.com/rate_limit");
 * ```
 */
export function wrapUndici(requestFn: typeof request, opts: PacerOptions = {}): PacedUndiciRequest {
  const engine = new Pacer(opts);
  const { keyFn } = resolvePacerOptions(opts);

  const paced = (url: string | URL, options?: UndiciRequestOptions): Promise<UndiciResponseData> =>
    engine.runWithRetry(
      () => requestFn(url, options),
      (res): ResponseView => ({
        status: res.statusCode,
        getHeader: headerGetter(res.headers),
        // Discarded retry responses must not stall the connection.
        discard: () => void res.body.dump().catch(() => {}),
      }),
      {
        key: keyFn(typeof url === "string" ? url : url.href, options as RequestInit),
        signal: options?.signal instanceof AbortSignal ? options.signal : undefined,
      },
    );
  return paced;
}
