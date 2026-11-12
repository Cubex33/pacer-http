import type { RateLimitState, RateLimitWindow, TokenQuota } from "../types.js";

/**
 * Anything that can answer "give me header X": a fetch `Headers` instance, a
 * `Response` (or Response-like with a `.headers.get`), a plain record
 * (e.g. Node's `res.headers`), or any `{ get(name) }` object.
 */
export type HeadersLike =
  | Headers
  | Response
  | { get(name: string): string | null }
  | { headers: { get(name: string): string | null } }
  | Record<string, string | string[] | undefined>;

type Getter = (name: string) => string | null;

/* ------------------------------------------------------------------ *
 * Structured fields (RFC 8941/9651) — minimal List subset.
 * Only what RateLimit / RateLimit-Policy need: lists of bare items
 * (integer, decimal, string, token, boolean, byte sequence) with
 * parameters, separated by OWS "," OWS or a single SP.
 * ------------------------------------------------------------------ */

export interface SfItem {
  value: number | string | boolean;
  params: Map<string, number | string | boolean>;
}

const OWS = new Set([" ", "\t"]);
const TOKEN_CHARS = new Set("abcdefghijklmnopqrstuvwxyz-_.:0123456789".split(""));
const B64_CHARS = /[A-Za-z0-9+/=]/;

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function parseSfString(s: string, start: number): { value: string; end: number } | null {
  const n = s.length;
  let j = start + 1;
  let out = "";
  for (;;) {
    if (j >= n) return null;
    const c = s[j]!;
    if (c === "\\") {
      if (j + 1 >= n) return null;
      const e = s[j + 1]!;
      if (e !== "\\" && e !== '"') return null;
      out += e;
      j += 2;
      continue;
    }
    if (c === '"') return { value: out, end: j + 1 };
    if (c < " " || c === "\x7f") return null;
    out += c;
    j++;
  }
}

function parseSfNumber(s: string, start: number): { value: number; end: number } | null {
  const n = s.length;
  let j = start;
  if (s[j] === "-") j++;
  const intStart = j;
  while (j < n && isDigit(s[j]!)) j++;
  const intDigits = j - intStart;
  if (intDigits === 0 || intDigits > 15) return null;
  if (j < n && s[j] === ".") {
    j++;
    const fracStart = j;
    while (j < n && isDigit(s[j]!)) j++;
    const fracDigits = j - fracStart;
    if (fracDigits === 0 || fracDigits > 3) return null;
  }
  const value = Number(s.slice(start, j));
  if (!Number.isFinite(value)) return null;
  return { value, end: j };
}

function parseSfToken(s: string, start: number): { value: string; end: number } {
  const n = s.length;
  let j = start + 1;
  while (j < n && TOKEN_CHARS.has(s[j]!)) j++;
  return { value: s.slice(start, j), end: j };
}

function parseSfByteSeq(s: string, start: number): { value: string; end: number } | null {
  const n = s.length;
  let j = start + 1;
  while (j < n && s[j] !== ":") {
    if (!B64_CHARS.test(s[j]!)) return null;
    j++;
  }
  if (j >= n) return null;
  return { value: s.slice(start + 1, j), end: j + 1 };
}

function parseSfBareItem(
  s: string,
  start: number,
): { value: number | string | boolean; end: number } | null {
  const n = s.length;
  if (start >= n) return null;
  const c = s[start]!;
  if (c === '"') return parseSfString(s, start);
  if (c === "-" || isDigit(c)) return parseSfNumber(s, start);
  if (c === ":") return parseSfByteSeq(s, start);
  if (c === "?") {
    if (start + 1 < n && (s[start + 1] === "0" || s[start + 1] === "1")) {
      return { value: s[start + 1] === "1", end: start + 2 };
    }
    return null;
  }
  if (c >= "a" && c <= "z") return parseSfToken(s, start);
  return null;
}

function parseSfKey(s: string, start: number): { key: string; end: number } | null {
  const n = s.length;
  if (start >= n) return null;
  const c = s[start]!;
  if (c < "a" || c > "z") return null;
  let j = start + 1;
  while (j < n && (s[j]! >= "a" && s[j]! <= "z" ? true : "_-.".includes(s[j]!))) j++;
  return { key: s.slice(start, j), end: j };
}

interface SfItemWithEnd {
  value: number | string | boolean;
  params: Map<string, number | string | boolean>;
  end: number;
}

function parseSfItem(s: string, start: number): SfItemWithEnd | null {
  const n = s.length;
  const bare = parseSfBareItem(s, start);
  if (bare === null) return null;
  let i = bare.end;
  const params = new Map<string, number | string | boolean>();
  for (;;) {
    let j = i;
    while (j < n && OWS.has(s[j]!)) j++;
    if (j >= n || s[j] !== ";") break;
    j++;
    while (j < n && OWS.has(s[j]!)) j++;
    const key = parseSfKey(s, j);
    if (key === null) return null;
    j = key.end;
    let value: number | string | boolean = true;
    if (j < n && s[j] === "=") {
      j++;
      const v = parseSfBareItem(s, j);
      if (v === null) return null;
      j = v.end;
      value = v.value;
    }
    if (params.has(key.key)) return null;
    params.set(key.key, value);
    i = j;
  }
  return { value: bare.value, params, end: i };
}

/**
 * Parses a Structured Fields *List*. Returns `null` for anything malformed
 * (the RateLimit drafts require malformed fields to be ignored).
 */
export function parseSfList(input: string): SfItem[] | null {
  const s = input;
  const n = s.length;
  const skipOws = (from: number): number => {
    let j = from;
    while (j < n && OWS.has(s[j]!)) j++;
    return j;
  };

  let i = skipOws(0);
  if (i >= n) return null;
  const items: SfItem[] = [];

  for (;;) {
    const item = parseSfItem(s, i);
    if (item === null) return null;
    items.push({ value: item.value, params: item.params });
    const itemEnd = item.end;
    let j = skipOws(itemEnd);
    if (j >= n) break;
    if (s[j] === ",") {
      j = skipOws(j + 1);
      if (j >= n) return null; // trailing comma — invalid list
      i = j;
      continue;
    }
    if (j > itemEnd) {
      // at least one whitespace consumed and a new item follows (SP separator)
      i = j;
      continue;
    }
    return null; // unexpected character right after the item
  }
  return items.length > 0 ? items : null;
}

/* ------------------------------------------------------------------ *
 * Value parsing helpers
 * ------------------------------------------------------------------ */

/** A `reset`-like header value: absent, invalid (garbage), or a date. */
type ResetValue = { kind: "absent" } | { kind: "invalid" } | { kind: "date"; date: Date };

/**
 * Values above this look like unix epoch *seconds* (covers now → ~year 2033).
 * Below it they are treated as delta-seconds from `now`.
 */
const EPOCH_SECONDS_THRESHOLD = 1e9;
/** Values above this look like unix epoch *milliseconds*. */
const EPOCH_MS_THRESHOLD = 1e12;

function parseResetValue(raw: string, nowMs: number): ResetValue {
  const v = raw.trim();
  if (v === "") return { kind: "absent" };
  if (/[a-z]/i.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? { kind: "invalid" } : { kind: "date", date: d };
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { kind: "invalid" };
  if (n >= EPOCH_MS_THRESHOLD) return { kind: "date", date: new Date(Math.round(n)) };
  if (n >= EPOCH_SECONDS_THRESHOLD) {
    return { kind: "date", date: new Date(Math.round(n * 1000)) };
  }
  return { kind: "date", date: new Date(nowMs + Math.round(n * 1000)) };
}

/** Strict non-negative integer header value; `null` when garbage. */
function parseUInt(raw: string): number | null {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

/** Signed decimal number (Discord uses fractional epochs / delta seconds). */
function parseNumber(raw: string): number | null {
  const v = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(v)) return null;
  return Number(v);
}

const DURATION_TOKEN = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;

/**
 * OpenAI-style duration strings: `"1ms"`, `"6s"`, `"2m33s"`, `"1h5m"`.
 * Returns total milliseconds or `null` when malformed.
 */
function parseDurationMs(raw: string): number | null {
  const v = raw.trim();
  if (v === "" || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h))+$/.test(v)) return null;
  let total = 0;
  for (const m of v.matchAll(DURATION_TOKEN)) {
    const n = Number(m[1]);
    const unit = m[2];
    if (unit === "ms") total += n;
    else if (unit === "s") total += n * 1000;
    else if (unit === "m") total += n * 60_000;
    else total += n * 3_600_000;
  }
  return total;
}

/* ------------------------------------------------------------------ *
 * Family plumbing
 * ------------------------------------------------------------------ */

type FamilyResult =
  { kind: "none" } | { kind: "state"; state: RateLimitState } | { kind: "garbage" };

const NONE: FamilyResult = { kind: "none" };
const GARBAGE: FamilyResult = { kind: "garbage" };

/** Collects and validates one legacy header family. */
class FamilyBuilder {
  present = false;
  garbage = false;
  private limit: number | null = null;
  private remaining: number | null = null;
  private reset: Date | null = null;
  private resetSeen = false;
  private unit: string | undefined;

  constructor(
    private readonly nowMs: number,
    unit?: string,
  ) {
    this.unit = unit;
  }

  setLimit(get: Getter, name: string): void {
    const v = get(name);
    if (v === null) return;
    this.present = true;
    const n = parseUInt(v);
    if (n === null) {
      this.garbage = true;
      return;
    }
    this.limit = n;
  }

  setRemaining(get: Getter, name: string): void {
    const v = get(name);
    if (v === null) return;
    this.present = true;
    const n = parseUInt(v);
    if (n === null) {
      this.garbage = true;
      return;
    }
    this.remaining = n;
  }

  setReset(get: Getter, name: string, mode: "auto" | "duration" | "date"): void {
    const v = get(name);
    if (v === null) return;
    this.present = true;
    this.resetSeen = true;
    let date: Date | null = null;
    if (mode === "duration") {
      const ms = parseDurationMs(v);
      date = ms === null ? null : new Date(this.nowMs + ms);
    } else if (mode === "date") {
      const d = new Date(v.trim());
      date = Number.isNaN(d.getTime()) ? null : d;
    } else {
      const r = parseResetValue(v, this.nowMs);
      date = r.kind === "date" ? r.date : null;
    }
    if (date === null) {
      this.garbage = true;
      return;
    }
    this.reset = date;
  }

  /**
   * Delta-seconds `reset-after` (Discord). Preferred over an epoch `reset`
   * when both are present: relative values survive clock skew.
   */
  preferResetAfter(get: Getter, name: string): void {
    const v = get(name);
    if (v === null) return;
    this.present = true;
    const n = parseNumber(v);
    if (n === null || n < 0) {
      this.garbage = true;
      return;
    }
    this.reset = new Date(this.nowMs + Math.round(n * 1000));
    this.resetSeen = true;
  }

  build(windows: RateLimitWindow[] = []): FamilyResult {
    if (!this.present) return NONE;
    if (this.garbage) return GARBAGE;
    // Any setter that flips `present` also sets a value, `resetSeen` or
    // `garbage`, so at least one field is populated whenever we get here.
    if (this.limit !== null && this.remaining !== null && this.remaining > this.limit) {
      return GARBAGE;
    }
    return {
      kind: "state",
      state: {
        limit: this.limit ?? -1,
        remaining: this.remaining ?? -1,
        reset: this.reset,
        windows,
        unit: this.unit,
      },
    };
  }
}

/* ------------------------------------------------------------------ *
 * IETF RateLimit / RateLimit-Policy (drafts 8+, plus draft-7 text)
 * ------------------------------------------------------------------ */

interface SfServiceLimit {
  id: string;
  remaining: number | null;
  reset: Date | null;
}

interface SfPolicy {
  id: string | null;
  limit: number | null;
  windowSec: number | null;
  unit: string | null;
}

function sfUint(
  params: Map<string, number | string | boolean>,
  key: string,
): number | null | "invalid" {
  if (!params.has(key)) return null;
  const v = params.get(key);
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return "invalid";
  return v;
}

function parseServiceLimits(raw: string, nowMs: number): SfServiceLimit[] | null {
  const items = parseSfList(raw);
  if (items === null) return null;
  const out: SfServiceLimit[] = [];
  for (const item of items) {
    if (typeof item.value !== "string") return null; // identifiers are strings
    const r = sfUint(item.params, "r");
    if (r === "invalid") return null;
    const t = sfUint(item.params, "t");
    if (t === "invalid") return null;
    out.push({
      id: item.value,
      remaining: r,
      reset: t === null ? null : new Date(nowMs + t * 1000),
    });
  }
  return out;
}

function parsePolicies(raw: string): SfPolicy[] | null {
  const items = parseSfList(raw);
  if (items === null) return null;
  const out: SfPolicy[] = [];
  for (const item of items) {
    const qu = item.params.get("qu");
    const w = sfUint(item.params, "w");
    if (w === "invalid") return null;
    if (typeof qu !== "undefined" && typeof qu !== "string") return null;
    if (typeof item.value === "string") {
      // draft-08+: `"id";q=100;w=60`
      const q = sfUint(item.params, "q");
      if (q === "invalid") return null;
      out.push({ id: item.value, limit: q, windowSec: w, unit: qu ?? null });
    } else if (typeof item.value === "number" && Number.isInteger(item.value) && item.value >= 0) {
      // older drafts: `10;w=1` (the item itself is the limit)
      out.push({ id: null, limit: item.value, windowSec: w, unit: qu ?? null });
    } else {
      return null;
    }
  }
  return out;
}

/** Draft-07 combined plain-text form: `RateLimit: limit=10, remaining=2, reset=10`. */
function parseDraft7Text(raw: string, nowMs: number): FamilyResult {
  const grab = (key: string): number | undefined | "negative" => {
    const m = new RegExp(`${key}\\s*=\\s*(-?\\d+)`, "i").exec(raw);
    if (m === null) return undefined;
    const n = Number(m[1]);
    return n < 0 ? "negative" : n;
  };
  const limit = grab("limit");
  const remaining = grab("remaining");
  const reset = grab("reset");
  if (limit === undefined && remaining === undefined && reset === undefined) {
    return NONE; // not the draft-7 text shape at all
  }
  if (limit === "negative" || remaining === "negative" || reset === "negative") {
    return GARBAGE;
  }
  if (limit !== undefined && remaining !== undefined && remaining > limit) {
    return GARBAGE;
  }
  return {
    kind: "state",
    state: {
      limit: limit === undefined ? -1 : limit,
      remaining: remaining === undefined ? -1 : remaining,
      reset: reset === undefined ? null : new Date(nowMs + reset * 1000),
      windows: [],
      unit: undefined,
    },
  };
}

interface MergedLimit {
  remaining: number | null;
  reset: Date | null;
  limit: number | null;
  windowSec: number | null;
  unit: string | null;
}

type MergedLimitWithRemaining = MergedLimit & { remaining: number };

function hasRemaining(m: MergedLimit): m is MergedLimitWithRemaining {
  return m.remaining !== null;
}

/** `remaining > limit` is the family's garbage signal for one dimension. */
function exceedsLimit(m: MergedLimitWithRemaining): boolean {
  return m.limit !== null && m.remaining > m.limit;
}

/** Most constrained service limit: min remaining; ties → earliest reset. */
function pickMostConstrained(
  candidates: MergedLimitWithRemaining[],
): MergedLimitWithRemaining | null {
  let best: MergedLimitWithRemaining | null = null;
  for (const m of candidates) {
    if (
      best === null ||
      m.remaining < best.remaining ||
      (m.remaining === best.remaining &&
        (best.reset === null || (m.reset !== null && m.reset < best.reset)))
    ) {
      best = m;
    }
  }
  return best;
}

function quotaOf(m: MergedLimitWithRemaining): TokenQuota {
  return { limit: m.limit ?? -1, remaining: m.remaining, reset: m.reset };
}

function parseIetfFamily(get: Getter, nowMs: number): FamilyResult {
  const rateLimitRaw = get("ratelimit");
  const policyRaw = get("ratelimit-policy");

  if (rateLimitRaw === null && policyRaw === null) return NONE;

  // Policy (informative; malformed policy is ignored, not fatal).
  const policies = policyRaw === null ? [] : (parsePolicies(policyRaw) ?? []);

  // `windows` describes the request dimension only: token policies are a
  // separate budget and are reported through `tokens`.
  const windows: RateLimitWindow[] = [];
  for (const p of policies) {
    if (p.unit !== "tokens" && p.limit !== null && p.windowSec !== null && p.windowSec > 0) {
      windows.push({ limit: p.limit, windowSec: p.windowSec });
    }
  }
  const tokenPolicies = policies.filter((p) => p.unit === "tokens");
  const requestPolicies = policies.filter((p) => p.unit !== "tokens");

  if (rateLimitRaw === null) {
    // policy-only response: no current quota info, but windows may be useful
    if (policies.length === 0) return NONE;
    let tokens: TokenQuota | undefined;
    if (tokenPolicies.length > 0) {
      const first = tokenPolicies[0]!;
      tokens = { limit: first.limit ?? -1, remaining: -1, reset: null };
    }
    if (requestPolicies.length === 0 && tokens !== undefined) {
      // Token policies only: the token dimension is the primary one.
      return {
        kind: "state",
        state: {
          limit: tokens.limit,
          remaining: -1,
          reset: null,
          windows,
          unit: "tokens",
          tokens,
        },
      };
    }
    return {
      kind: "state",
      state: {
        limit: -1,
        remaining: -1,
        reset: null,
        windows,
        unit: undefined,
        ...(tokens === undefined ? {} : { tokens }),
      },
    };
  }

  const serviceLimits = parseServiceLimits(rateLimitRaw, nowMs);
  if (serviceLimits === null) {
    // Not a valid SF list — maybe the draft-07 text form.
    const draft7 = parseDraft7Text(rateLimitRaw, nowMs);
    if (draft7.kind === "none") return NONE; // malformed → ignore family
    if (draft7.kind === "garbage") return GARBAGE;
    return draft7;
  }

  // Merge service limits with policies by identifier.
  const consumed = new Set<number>();
  const merged = serviceLimits.map((sl) => {
    let policy: SfPolicy | null = null;
    for (const [index, p] of policies.entries()) {
      if (!consumed.has(index) && p.id !== null && p.id === sl.id) {
        consumed.add(index);
        policy = p;
        break;
      }
    }
    return {
      remaining: sl.remaining,
      reset: sl.reset,
      limit: policy?.limit ?? null,
      windowSec: policy?.windowSec ?? null,
      unit: policy?.unit ?? null,
    };
  });

  const requestMerged = merged.filter((m) => m.unit !== "tokens");
  const tokenMerged = merged.filter((m) => m.unit === "tokens");
  const tokenWithRemaining = tokenMerged.filter(hasRemaining);
  const cleanTokens = tokenWithRemaining.filter((m) => !exceedsLimit(m));
  const bestRequest = pickMostConstrained(requestMerged.filter(hasRemaining));
  const bestToken = pickMostConstrained(cleanTokens);
  const tokenQuota = bestToken === null ? undefined : quotaOf(bestToken);

  if (bestRequest !== null) {
    // Garbage in the request dimension makes the whole family garbage, as
    // before. Garbage in the token dimension only drops the token quota.
    if (exceedsLimit(bestRequest)) return GARBAGE;
    return {
      kind: "state",
      state: {
        limit: bestRequest.limit ?? -1,
        remaining: bestRequest.remaining,
        reset: bestRequest.reset,
        windows,
        unit: bestRequest.unit ?? undefined,
        ...(tokenQuota === undefined ? {} : { tokens: tokenQuota }),
      },
    };
  }

  if (tokenQuota !== undefined) {
    // Token dimension only: it becomes the primary dimension.
    return {
      kind: "state",
      state: {
        limit: tokenQuota.limit,
        remaining: tokenQuota.remaining,
        reset: tokenQuota.reset,
        windows,
        unit: "tokens",
        tokens: tokenQuota,
      },
    };
  }

  // Only garbage token service limits: nothing usable in this family.
  if (tokenWithRemaining.length > 0 && cleanTokens.length === 0) return GARBAGE;

  // Service limits without any `r` parameter: only window/reset info.
  const withReset = requestMerged.find((m) => m.reset !== null);
  return {
    kind: "state",
    state: {
      limit: -1,
      remaining: -1,
      reset: withReset?.reset ?? null,
      windows,
      unit: undefined,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Legacy families
 * ------------------------------------------------------------------ */

/** Early IETF drafts, uncombined (GitLab): RateLimit-Limit/Remaining/Reset/ResetTime. */
function parseGitLabFamily(get: Getter, nowMs: number): FamilyResult {
  const b = new FamilyBuilder(nowMs);
  b.setLimit(get, "ratelimit-limit");
  b.setRemaining(get, "ratelimit-remaining");
  b.setReset(get, "ratelimit-reset", "auto");
  b.setReset(get, "ratelimit-resettime", "date");
  return b.build();
}

/** A family that advertises separate request and token dimensions. */
interface UnitHeaderNames {
  limit: string;
  remaining: string;
  reset: string;
}

function buildUnitFamily(
  get: Getter,
  nowMs: number,
  unit: "requests" | "tokens",
  names: (unit: "requests" | "tokens") => UnitHeaderNames,
  resetMode: "duration" | "date",
): FamilyResult {
  const n = names(unit);
  const b = new FamilyBuilder(nowMs, unit);
  b.setLimit(get, n.limit);
  b.setRemaining(get, n.remaining);
  b.setReset(get, n.reset, resetMode);
  return b.build();
}

function quotaFromState(state: RateLimitState): TokenQuota {
  return { limit: state.limit, remaining: state.remaining, reset: state.reset };
}

/**
 * Combines the two dimensions of an OpenAI/Anthropic-style family.
 *
 * Garbage policy (deterministic, documented): garbage in the request
 * dimension makes the whole family garbage (unchanged behaviour); garbage in
 * the token dimension only drops the token quota and keeps the request
 * state. When requests are absent and tokens are usable, tokens become the
 * primary dimension (`unit: "tokens"`) and are also exposed via `tokens`.
 */
function combineDualUnit(requests: FamilyResult, tokens: FamilyResult): FamilyResult {
  if (requests.kind === "garbage") return GARBAGE;
  if (requests.kind === "state") {
    if (tokens.kind === "state") {
      return {
        kind: "state",
        state: { ...requests.state, tokens: quotaFromState(tokens.state) },
      };
    }
    return requests;
  }
  if (tokens.kind === "state") {
    return {
      kind: "state",
      state: { ...tokens.state, tokens: quotaFromState(tokens.state) },
    };
  }
  return tokens.kind === "garbage" ? GARBAGE : NONE;
}

function parseDualUnitFamily(
  get: Getter,
  nowMs: number,
  names: (unit: "requests" | "tokens") => UnitHeaderNames,
  resetMode: "duration" | "date",
): FamilyResult {
  return combineDualUnit(
    buildUnitFamily(get, nowMs, "requests", names, resetMode),
    buildUnitFamily(get, nowMs, "tokens", names, resetMode),
  );
}

/** OpenAI: x-ratelimit-{requests,tokens}-{limit,remaining,reset} (reset is a duration string). */
function parseOpenAiFamily(get: Getter, nowMs: number): FamilyResult {
  return parseDualUnitFamily(
    get,
    nowMs,
    (unit) => ({
      limit: `x-ratelimit-limit-${unit}`,
      remaining: `x-ratelimit-remaining-${unit}`,
      reset: `x-ratelimit-reset-${unit}`,
    }),
    "duration",
  );
}

/** Anthropic: anthropic-ratelimit-{requests,tokens}-{limit,remaining,reset} (reset is RFC 3339). */
function parseAnthropicFamily(get: Getter, nowMs: number): FamilyResult {
  return parseDualUnitFamily(
    get,
    nowMs,
    (unit) => ({
      limit: `anthropic-ratelimit-${unit}-limit`,
      remaining: `anthropic-ratelimit-${unit}-remaining`,
      reset: `anthropic-ratelimit-${unit}-reset`,
    }),
    "date",
  );
}

/** GitHub / Discord / Square / …: x-ratelimit-{limit,remaining,reset[,reset-after]}. */
function parseXFamily(get: Getter, nowMs: number): FamilyResult {
  const b = new FamilyBuilder(nowMs);
  b.setLimit(get, "x-ratelimit-limit");
  b.setRemaining(get, "x-ratelimit-remaining");
  b.setReset(get, "x-ratelimit-reset", "auto");
  const result = b.build();
  if (result.kind === "state") {
    // Discord's X-RateLimit-Reset-After wins over the epoch when both exist.
    const b2 = new FamilyBuilder(nowMs);
    b2.preferResetAfter(get, "x-ratelimit-reset-after");
    const ra = b2.build();
    if (ra.kind === "state") {
      return {
        kind: "state",
        state: { ...result.state, reset: ra.state.reset },
      };
    }
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function normalizeHeaders(headers: HeadersLike): Getter {
  const h = headers as
    { get?: unknown } | { headers?: { get?: unknown } } | Record<string, unknown>;
  if (typeof (h as { get?: unknown })?.get === "function") {
    const getter = (h as { get(name: string): string | null }).get.bind(h);
    return (name) => getter(name);
  }
  const nested = (h as { headers?: { get?: unknown } })?.headers;
  if (nested !== undefined && typeof nested.get === "function") {
    // Response and Response-like objects
    const getter = (nested as { get(name: string): string | null }).get.bind(nested);
    return (name) => getter(name);
  }
  if (typeof headers === "object" && headers !== null) {
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) continue;
      map.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
    }
    return (name) => map.get(name) ?? null;
  }
  return () => null;
}

/**
 * Parses rate-limit headers of every supported family into a normalized
 * {@link RateLimitState}, or `null` when the response carries no usable
 * rate-limit information or only garbage (per the spec, garbage must not
 * update any state and must not throw).
 *
 * Families, in priority order:
 *
 * 1. IETF `RateLimit` + `RateLimit-Policy` (draft-ietf-httpapi-ratelimit-headers
 *    08+, structured fields, multi-window policies; the draft-07 combined
 *    text form is also accepted). Malformed IETF fields are ignored and
 *    legacy families are tried instead.
 * 2. Early-draft uncombined `RateLimit-Limit/-Remaining/-Reset[-ResetTime]`
 *    (GitLab).
 * 3. OpenAI `x-ratelimit-{requests,tokens}-*`.
 * 4. Anthropic `anthropic-ratelimit-{requests,tokens}-*`.
 * 5. Generic `x-ratelimit-{limit,remaining,reset[,reset-after]}` (GitHub,
 *    Discord, Square, …).
 *
 * `now` anchors relative values (delta-seconds resets, IETF `t` parameters);
 * it defaults to the current time and is injectable for deterministic tests.
 */
export function parseRateLimitHeaders(
  headers: HeadersLike,
  now: Date | number = new Date(),
): RateLimitState | null {
  const get = normalizeHeaders(headers);
  const nowMs = now instanceof Date ? now.getTime() : now;

  const families: Array<(get: Getter, nowMs: number) => FamilyResult> = [
    parseIetfFamily,
    parseGitLabFamily,
    parseOpenAiFamily,
    parseAnthropicFamily,
    parseXFamily,
  ];

  for (const family of families) {
    const result = family(get, nowMs);
    if (result.kind === "none") continue;
    if (result.kind === "garbage") return null;
    return result.state;
  }
  return null;
}
