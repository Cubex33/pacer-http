/**
 * Case-insensitive single-value header lookup for the header shapes axios,
 * got and undici hand to user code:
 *
 * - `AxiosHeaders` (axios v1) and fetch-style `Headers` — both have a
 *   case-insensitive `.get`; to stay case-insensitive even with a
 *   case-sensitive `.get` (lowercase keys), a miss is retried lowercased;
 * - plain records (axios v0, got, undici, Node's `IncomingMessage`) —
 *   keys are lowercased into a map for O(1) case-insensitive access.
 *
 * Multiple values are joined with `", "` per HTTP list semantics; numbers and
 * booleans (possible in AxiosHeaders) are stringified. Anything else yields
 * `null` — parsing then treats the header as absent, never throws.
 */
export function headerGetter(headers: unknown): (name: string) => string | null {
  const h = headers as { get?: unknown } | null | undefined;
  if (h !== null && h !== undefined && typeof h === "object") {
    if (typeof h.get === "function") {
      const get = (h as { get(name: string): unknown }).get.bind(h);
      return (name) => {
        const direct = normalizeHeaderValue(get(name));
        return direct ?? normalizeHeaderValue(get(name.toLowerCase()));
      };
    }
    const record = headers as Record<string, unknown>;
    const map = new Map<string, string>();
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      map.set(key.toLowerCase(), normalizeHeaderValue(value) ?? "");
    }
    return (name: string) => map.get(name.toLowerCase()) ?? null;
  }
  return () => null;
}

function normalizeHeaderValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String).join(", ");
  return String(value);
}
