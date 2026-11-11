/**
 * Parses a `Retry-After` header value (RFC 9110 §10.2.3) into the number of
 * milliseconds to wait.
 *
 * Supported forms:
 * - delay-seconds: a non-negative decimal integer (`"120"` → 120000 ms).
 *   `"0"` is valid and returns `0`.
 * - HTTP-date (IMF-fixdate and the obsolete RFC 850 / asctime forms are
 *   accepted by way of the platform date parser): the delta to `now`,
 *   clamped at `0` for dates in the past.
 *
 * Returns `null` when the value is absent, empty or invalid — callers should
 * fall back to their own backoff strategy in that case.
 *
 * @param value raw header value (already combined if the field was repeated).
 * @param now reference "now" (defaults to the current time); injected for
 *        deterministic tests.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date | number = new Date(),
): number | null {
  if (value === null || value === undefined) return null;
  const raw = value.trim();
  if (raw === "") return null;

  const nowMs = now instanceof Date ? now.getTime() : now;

  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000;
  }

  if (/[a-z]/i.test(raw)) {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return Math.max(0, date.getTime() - nowMs);
  }

  // Numbers with signs, fractions or any other junk are not valid
  // delay-seconds values; treat them as unparseable.
  return null;
}
