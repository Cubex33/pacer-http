/**
 * axios adapter — do NOT import axios at runtime from here: this module
 * must stay dependency-free. Only the types are referenced (`import type`
 * is erased at build time), the client itself is injected by the caller.
 */
import type { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { resolvePacerOptions } from "../limiter/limiter.js";
import { Pacer, type ResponseView } from "../pacer.js";
import type { PacerOptions } from "../types.js";
import { headerGetter } from "./headers.js";

/**
 * The callable wrapper returned by {@link wrapAxios}: the instance's
 * `(url, config?)` call plus its usual method shortcuts, all paced and
 * retried by the engine. Resolves native `AxiosResponse` objects.
 */
export interface PacedAxios {
  /** Like `instance(url, config?)`. */
  <T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  /** Like `instance.request(config)` (method and url live in the config). */
  request<T = unknown, D = unknown>(config: AxiosRequestConfig<D>): Promise<AxiosResponse<T, D>>;
  get<T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  delete<T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  head<T = unknown, D = unknown>(
    url: string,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  post<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  put<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
  patch<T = unknown, D = unknown>(
    url: string,
    data?: D,
    config?: AxiosRequestConfig<D>,
  ): Promise<AxiosResponse<T, D>>;
}

/** Resolves a request URL against the instance's `baseURL` (for keying). */
function resolveRequestUrl(url: string, baseURL?: string): string {
  const base = baseURL?.trim();
  if (base === undefined || base === "") return url;
  try {
    return new URL(url, base).href;
  } catch {
    // Relative baseURL (e.g. "/api"): axios concatenates, so we do too.
    return `${base.replace(/\/+$/, "")}/${url.replace(/^\/+/, "")}`;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Wraps an axios instance with adaptive client-side rate limiting.
 *
 * The wrapper calls **through** the instance (`instance.request(config)`),
 * so the instance's interceptors, defaults and adapters keep working.
 * Responses are parsed for `RateLimit` / `X-RateLimit-*` headers (axios v1
 * `AxiosHeaders` and axios v0 plain-object headers are both normalized) and
 * the pacer pauses before overdrawing the advertised budget; statuses in
 * `retryOn` (default `[429]`) are retried after exactly `Retry-After` (+
 * jitter), then {@link PacerExhaustedError} carries the native
 * `AxiosResponse`. Non-retryable error statuses rethrow axios's own
 * `AxiosError` unchanged, so `validateStatus` semantics are preserved.
 *
 * Bucket keys come from `config.url` resolved against the instance's
 * `baseURL` (a custom `key` option receives that URL and the config as
 * `init`). `config.signal` aborts pacing waits and is forwarded to axios.
 *
 * Do **not** combine this with axios-retry or similar retry plugins: both
 * would retry the same 429, doubling the request count.
 *
 * @example
 * ```ts
 * import axios from "axios";
 * import { wrapAxios } from "pacer-http/axios";
 *
 * const api = wrapAxios(axios.create({ baseURL: "https://api.github.com" }));
 * const res = await api.get("/rate_limit");
 * console.log(res.status, res.headers["x-ratelimit-remaining"]);
 * ```
 */
export function wrapAxios(axiosInstance: AxiosInstance, opts: PacerOptions = {}): PacedAxios {
  const engine = new Pacer(opts);
  const { keyFn } = resolvePacerOptions(opts);

  async function pacedRequest(config: AxiosRequestConfig): Promise<AxiosResponse> {
    const url = resolveRequestUrl(config.url ?? "", axiosInstance.defaults.baseURL);
    // Responses axios delivered as a thrown error: the engine needs the
    // response to decide on a retry, but a non-retried one must rethrow the
    // original error to preserve axios's validateStatus semantics.
    const thrownFor = new WeakMap<object, unknown>();
    const dispatch = async (): Promise<AxiosResponse> => {
      try {
        return await axiosInstance.request(config);
      } catch (err) {
        const response = isObject(err) ? err.response : undefined;
        if (isObject(response)) {
          thrownFor.set(response, err);
          return response as unknown as AxiosResponse;
        }
        throw err; // network errors, cancellations, … propagate as-is
      }
    };
    const view = (res: AxiosResponse): ResponseView => ({
      status: res.status,
      getHeader: headerGetter(res.headers),
      error: thrownFor.get(res),
    });
    return engine.runWithRetry(dispatch, view, {
      key: keyFn(url, config as RequestInit),
      // axios accepts AbortController signals (typed as its own
      // GenericAbortSignal shape); users pass real AbortSignals.
      signal: config.signal as AbortSignal | undefined,
    });
  }

  const wrapper = Object.assign(
    (url: string, config?: AxiosRequestConfig) => pacedRequest({ ...config, url }),
    {
      request: (config: AxiosRequestConfig) => pacedRequest(config),
      get: (url: string, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, method: "get" }),
      delete: (url: string, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, method: "delete" }),
      head: (url: string, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, method: "head" }),
      post: (url: string, data?: unknown, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, data, method: "post" }),
      put: (url: string, data?: unknown, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, data, method: "put" }),
      patch: (url: string, data?: unknown, config?: AxiosRequestConfig) =>
        pacedRequest({ ...config, url, data, method: "patch" }),
    },
  );
  return wrapper as PacedAxios;
}
