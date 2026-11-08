// Crash-report scrubber (plan Task 20 Step 2). A PURE function used as Sentry's `beforeSend`: it returns a
// deep copy of the event with everything that could identify money, accounts, people or the ERPNext site
// removed. It never throws: on anything unexpected it returns null, which tells Sentry to drop the event.
//
// Removed or replaced, everywhere in the event (message, exception values, breadcrumbs, extra, contexts,
// request, user, tags, stack frame vars):
//   - amounts: "₹ 1,234.50", "Rs.500", "INR 12,000", "USD 40", plain decimals such as 1,00,000.00 or 5000.00
//   - long digit runs (6+ digits: account numbers, UTRs, phone numbers) and masked accounts (XX6507)
//   - UTR-like tokens: letters and digits mixed, 10 characters or more (IDFB6292M4509651)
//   - email addresses
//   - URLs: reduced to scheme + "<site>" + path (query string and fragment removed); bare host names too
//   - whole fields: anything named like an SMS/body/message payload, and anything named like a credential
//     (api key, secret, password, authorization, token, cookie, sid)
// Kept: event id, timestamps, platform, level, release, environment, sdk, debug_meta (symbolication), exception
// type names, stack frame file names/functions/line numbers.

export type ScrubOptions = {
  /** Host names to replace with "<site>" wherever they appear (e.g. the signed-in ERPNext site). */
  hosts?: string[];
};

const AMOUNT = '<amount>';
const NUM = '<num>';
const REF = '<ref>';
const EMAIL = '<email>';
const SITE = '<site>';
const ACCT = '<acct>';
const REDACTED = '<redacted>';
const MAX_DEPTH = 40;

// Top-level fields that carry no user data and must survive untouched (Sentry needs them as they are).
const KEEP_TOP = new Set(['event_id', 'timestamp', 'start_timestamp', 'platform', 'level', 'release', 'dist', 'environment', 'sdk', 'debug_meta', 'type', 'logger']);
// Numeric fields that are not amounts or identifiers.
const KEEP_NUMBER_KEYS = new Set(['timestamp', 'start_timestamp', 'lineno', 'colno', 'status_code', 'level', 'thread_id']);
// Breadcrumbs of these categories can carry request bodies, URLs with queries or console output.
export const DROPPED_BREADCRUMB_CATEGORIES = new Set(['console', 'fetch', 'xhr', 'http']);

const CREDENTIAL_KEY = /api[_-]?key|secret|passw(or)?d|authori[sz]ation|token|cookie|^sid$|^session$|^auth$/i;
// Payload-like fields: the SMS text, request/response bodies, raw messages.
const PAYLOAD_KEY = /body|sms|message|^raw|^text$|^data$|query_string|^query$/i;
// Fields with money or account content whatever their value looks like.
const MONEY_KEY = /amount|balance|minor|^paid|^total|debit|credit|utr|reference|cheque|account|last4|counterparty|merchant|party|ifsc|iban/i;
// User identity fields.
const USER_KEY = /email|username|ip_address|^name$|phone/i;

const TLDS = 'com|in|io|net|org|app|cloud|co|dev|biz|info|site|online|tech|xyz';

function scrubUrl(_m: string, scheme: string, _host: string, path: string): string {
  return `${scheme.toLowerCase()}://${SITE}${path ?? ''}`;
}

/** Scrubs one string. Exported for tests; idempotent. */
export function scrubText(input: string, opts: ScrubOptions = {}): string {
  let s = input;
  for (const h of opts.hosts ?? []) {
    if (h && h.length >= 3) s = s.split(h).join(SITE);
  }
  // URLs: scheme://host[:port]/path?query#frag -> scheme://<site>/path
  s = s.replace(/\b(https?|wss?):\/\/([^\s/"'<>?#]+)([^\s"'<>?#]*)(?:\?[^\s<>#]*)?(?:#[^\s<>]*)?/gi, scrubUrl);
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, EMAIL);
  // Bare host names (no scheme) on common TLDs.
  s = s.replace(new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLDS})\\b(?![.\\w])`, 'gi'), SITE);
  // Currency-prefixed amounts.
  s = s.replace(/(?:₹|\bRs\.?|\bINR|\bUSD|\$)\s*-?\d[\d,]*(?:\.\d+)?/gi, AMOUNT);
  // Amounts followed by a currency word.
  s = s.replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:INR|USD|rupees?)\b/gi, AMOUNT);
  // Grouped numbers (1,00,000 / 1,000,000.00) and plain 2-decimal amounts (5000.00), not inside versions.
  s = s.replace(/(?<![\d.,])\d{1,3}(?:,\d{2,3})+(?:\.\d+)?(?![\d.,])/g, AMOUNT);
  s = s.replace(/(?<![\d.])\d+\.\d{2}(?![\d.])/g, AMOUNT);
  // Masked account numbers (XX6507, ****1234).
  s = s.replace(/(?:[Xx*]{2,})\d{3,}/g, ACCT);
  // UTR-like: letters and digits mixed, 10+ characters.
  s = s.replace(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}\b/g, REF);
  // Long digit runs.
  s = s.replace(/\d{6,}/g, NUM);
  return s;
}

type Ctx = { opts: ScrubOptions; seen: WeakMap<object, unknown> };

function scrubNumber(key: string | null, n: number): unknown {
  if (key && KEEP_NUMBER_KEYS.has(key)) return n;
  if (key && MONEY_KEY.test(key)) return REDACTED;
  if (!Number.isFinite(n)) return n;
  return Math.abs(Math.trunc(n)) >= 100000 ? NUM : n;
}

function walk(value: unknown, key: string | null, ctx: Ctx, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return key && MONEY_KEY.test(key) ? REDACTED : scrubText(value, ctx.opts);
  if (typeof value === 'number') return scrubNumber(key, value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return NUM;
  if (typeof value !== 'object') return undefined; // functions, symbols
  if (depth > MAX_DEPTH) return '[Depth]';
  if (ctx.seen.has(value)) return '[Circular]';
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    ctx.seen.set(value, out);
    for (const v of value) out.push(walk(v, key, ctx, depth + 1));
    return out;
  }
  const out: Record<string, unknown> = {};
  ctx.seen.set(value, out);
  for (const k of Object.keys(value)) {
    if (CREDENTIAL_KEY.test(k) || PAYLOAD_KEY.test(k)) continue;
    let v: unknown;
    try {
      v = (value as Record<string, unknown>)[k];
    } catch {
      continue; // a throwing getter
    }
    const w = walk(v, k, ctx, depth + 1);
    if (w !== undefined) out[k] = w;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function scrubBreadcrumb(b: unknown, ctx: Ctx): unknown {
  if (!isObj(b)) return undefined;
  if (typeof b.category === 'string' && DROPPED_BREADCRUMB_CATEGORIES.has(b.category)) return undefined;
  if (b.type === 'http') return undefined;
  const { message, ...rest } = b;
  const out = walk(rest, null, ctx, 1) as Record<string, unknown>;
  if (typeof message === 'string') out.message = scrubText(message, ctx.opts);
  return out;
}

function scrubException(ex: unknown, ctx: Ctx): unknown {
  if (!isObj(ex)) return walk(ex, null, ctx, 1);
  const { values, ...rest } = ex;
  const out = walk(rest, null, ctx, 1) as Record<string, unknown>;
  if (Array.isArray(values)) {
    out.values = values.map((v) => {
      if (!isObj(v)) return walk(v, null, ctx, 2);
      const { value, type, ...other } = v;
      const o = walk(other, null, ctx, 2) as Record<string, unknown>;
      if (typeof type === 'string') o.type = scrubText(type, ctx.opts);
      if (typeof value === 'string') o.value = scrubText(value, ctx.opts);
      return o;
    });
  }
  return out;
}

function scrubRequest(req: unknown, ctx: Ctx): unknown {
  if (!isObj(req)) return undefined;
  const out: Record<string, unknown> = {};
  if (typeof req.url === 'string') out.url = scrubText(req.url, ctx.opts);
  if (typeof req.method === 'string') out.method = req.method;
  if (isObj(req.headers)) out.headers = walk(req.headers, null, ctx, 2);
  // data, query_string, cookies, env: dropped
  return out;
}

function scrubUser(u: unknown, ctx: Ctx): unknown {
  if (!isObj(u)) return undefined;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(u)) if (!USER_KEY.test(k)) out[k] = u[k];
  return walk(out, null, ctx, 2);
}

/**
 * Sentry `beforeSend`: a scrubbed deep copy of `event` (see the header), or null when it cannot be scrubbed.
 * Never throws and never mutates its input. Not an object in, the same value scrubbed out.
 */
export function scrubEvent<T>(event: T, opts: ScrubOptions = {}): T | null {
  try {
    const ctx: Ctx = { opts, seen: new WeakMap() };
    if (!isObj(event)) return walk(event, null, ctx, 0) as T;
    const out: Record<string, unknown> = {};
    ctx.seen.set(event, out);
    for (const k of Object.keys(event)) {
      const v = event[k];
      if (KEEP_TOP.has(k)) {
        out[k] = v;
      } else if (k === 'message') {
        if (typeof v === 'string') out.message = scrubText(v, opts);
      } else if (k === 'logentry') {
        if (isObj(v) && typeof v.message === 'string') out.logentry = { message: scrubText(v.message, opts) }; // params dropped
      } else if (k === 'exception') {
        out.exception = scrubException(v, ctx);
      } else if (k === 'breadcrumbs') {
        const list = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.values) ? v.values : [];
        const kept = list.map((b) => scrubBreadcrumb(b, ctx)).filter((b) => b !== undefined);
        out.breadcrumbs = Array.isArray(v) ? kept : { values: kept };
      } else if (k === 'request') {
        const r = scrubRequest(v, ctx);
        if (r !== undefined) out.request = r;
      } else if (k === 'user') {
        const u = scrubUser(v, ctx);
        if (u !== undefined) out.user = u;
      } else if (CREDENTIAL_KEY.test(k)) {
        // dropped
      } else {
        // extra, contexts, tags, threads (stack frames with vars), transaction, fingerprint, ...
        const w = walk(v, k === 'extra' || k === 'contexts' || k === 'tags' ? null : k, ctx, 1);
        if (w !== undefined) out[k] = w;
      }
    }
    return out as T;
  } catch {
    return null;
  }
}
