// Crash-report scrubber (plan Task 20 Step 2). A PURE function used as Sentry's `beforeSend`: it returns a
// deep copy of the event with everything that could identify money, accounts, people or the ERPNext site
// removed. It never throws: on anything unexpected it returns null, which tells Sentry to drop the event.
//
// Removed or replaced, everywhere in the event (message, exception values, breadcrumbs, extra, contexts,
// request, user, tags, stack frame vars):
//   - amounts: "₹ 1,234.50", "Rs.500", "INR 12,000", "USD 40", grouped or 1-2 decimal numbers such as
//     1,00,000.00, 5000.0 or 5000.00, and any number next to a money word ("Paid Amount 500", "balance: 42")
//   - long digit runs (6+ digits, also split by single spaces or dashes: account numbers, UTRs, phone numbers
//     such as +91 98765 43210) and masked accounts (XX6507)
//   - UTR-like tokens: letters and digits mixed, 10 characters or more (IDFB6292M4509651; `_` separates tokens)
//   - email addresses
//   - URLs: reduced to scheme + "<site>" + path (query string and fragment removed); bare host names too
//   - whole fields: anything named like an SMS/body/message payload, and anything named like a credential
//     (api key, secret, password, authorization, token, cookie, sid)
// Object keys go through the same text scrubbing as values. Strings over 8 KB are truncated first.
// Kept: event id, timestamps, platform, level, release, environment, sdk, debug_meta (symbolication), exception
// type names, stack frame file names/functions/line numbers, trace/span ids, and the numbers of the
// device/os/app contexts (memory, storage).

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

// Strings longer than this are cut (at a word boundary when one is near) before any pattern runs, so the
// scrubber's cost stays bounded, and marked with TRUNCATED.
const MAX_TEXT = 8192;
const TRUNCATED = ' …<truncated>';
// "Word" boundaries that treat `_` as a separator (UTR_IDFB6292M4509651, paid_amount 500).
const NB = '(?<![A-Za-z0-9])';
const NA = '(?![A-Za-z0-9])';
// A number written next to one of these words is an amount, whatever its size.
const MONEY_WORD_BEFORE = '(?:amounts?|amt|paid|credited|debited|balance|bal|rs|inr|totals?|outstanding)';
const MONEY_WORD_AFTER = '(?:paid|credited|debited|outstanding)';
const NUMBER = '-?\\d(?:[\\d,.]*\\d)?';

const RE_URL = /\b(https?|wss?):\/\/([^\s/"'<>?#]+)([^\s"'<>?#]*)(?:\?[^\s<>#]*)?(?:#[^\s<>]*)?/gi;
// Bounded local part and domain, and a match may only start at the beginning of a token: linear time.
const RE_EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const RE_HOST = new RegExp(`(?<![a-z0-9.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLDS})\\b(?![.\\w])`, 'gi');
const RE_CURRENCY_BEFORE = new RegExp(`(?:₹|${NB}Rs\\.?|${NB}INR|${NB}USD|\\$)\\s*-?\\d[\\d,]*(?:\\.\\d+)?`, 'gi');
const RE_CURRENCY_AFTER = new RegExp(`${NB}\\d[\\d,]*(?:\\.\\d+)?\\s*(?:INR|USD|rupees?)${NA}`, 'gi');
const RE_GROUPED = /(?<![\d.,])\d{1,3}(?:,\d{2,3})+(?:\.\d+)?(?![\d,]|\.\d)/g;
// 1 or 2 decimals (5000.0, 5000.00), not part of a version such as 1.0.0.
const RE_DECIMAL = /(?<!\d|\d\.)\d+\.\d{1,2}(?!\d|\.\d)/g;
const RE_MONEY_WORD_BEFORE = new RegExp(`${NB}(${MONEY_WORD_BEFORE})([\\s:=_.-]*(?:(?:of|by|for|is|was|with)\\s+)?)${NUMBER}${NA}`, 'gi');
const RE_MONEY_WORD_AFTER = new RegExp(`${NB}${NUMBER}(\\s*)(?=${MONEY_WORD_AFTER}${NA})`, 'gi');
const RE_MASKED = /(?:[Xx*]{2,})\d{3,}/g;
const RE_REF = new RegExp(`${NB}(?=[A-Za-z0-9]*\\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}${NA}`, 'g');
// Digit groups split by single spaces or dashes (+91 98765 43210, 5010-0123-4567): one number.
const RE_DIGIT_GROUPS = /\+?\d+(?:[ -]\d+)+/g;
const RE_LONG_DIGITS = /\d{6,}/g;

function scrubUrl(_m: string, scheme: string, _host: string, path: string): string {
  return `${scheme.toLowerCase()}://${SITE}${path ?? ''}`;
}

const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Cuts `s` to at most MAX_TEXT characters (at a space in the last quarter when there is one) plus the marker. */
function cap(s: string): string {
  if (s.length <= MAX_TEXT + TRUNCATED.length) return s;
  const head = s.slice(0, MAX_TEXT);
  const sp = head.lastIndexOf(' ');
  return (sp > (MAX_TEXT * 3) / 4 ? head.slice(0, sp) : head) + TRUNCATED;
}

/** Scrubs one string. Exported for tests; idempotent. */
export function scrubText(input: string, opts: ScrubOptions = {}): string {
  let s = cap(input);
  const hosts = (opts.hosts ?? []).filter((h) => h && h.length >= 3).sort((a, b) => b.length - a.length);
  for (const h of hosts) s = s.replace(new RegExp(escapeRe(h), 'gi'), SITE);
  s = s.replace(RE_URL, scrubUrl); // scheme://host[:port]/path?query#frag -> scheme://<site>/path
  s = s.replace(RE_EMAIL, EMAIL);
  s = s.replace(RE_HOST, SITE); // bare host names (no scheme) on common TLDs
  s = s.replace(RE_CURRENCY_BEFORE, AMOUNT);
  s = s.replace(RE_CURRENCY_AFTER, AMOUNT);
  s = s.replace(RE_GROUPED, AMOUNT); // 1,00,000 / 1,000,000.00
  s = s.replace(RE_DECIMAL, AMOUNT);
  s = s.replace(RE_MONEY_WORD_BEFORE, (_m, w: string, sep: string) => `${w}${sep}${AMOUNT}`);
  s = s.replace(RE_MONEY_WORD_AFTER, (_m, sp: string) => `${AMOUNT}${sp}`);
  s = s.replace(RE_MASKED, ACCT); // XX6507, ****1234
  s = s.replace(RE_REF, REF); // UTR-like: letters and digits mixed, 10+ characters
  s = s.replace(RE_DIGIT_GROUPS, (m) => (m.replace(/\D/g, '').length >= 6 ? NUM : m));
  s = s.replace(RE_LONG_DIGITS, NUM);
  return cap(s);
}

type Ctx = { opts: ScrubOptions; seen: WeakMap<object, unknown> };

function scrubNumber(key: string | null, n: number): unknown {
  if (key && KEEP_NUMBER_KEYS.has(key)) return n;
  if (key && MONEY_KEY.test(key)) return REDACTED;
  if (!Number.isFinite(n)) return n;
  return Math.abs(Math.trunc(n)) >= 100000 ? NUM : n;
}

/** Sets `out[key]` (the key scrubbed like any text; `#2`, `#3` ... when two keys scrub to the same text). */
function setScrubbedKey(out: Record<string, unknown>, key: string, value: unknown, ctx: Ctx): void {
  const base = scrubText(key, ctx.opts);
  let k = base;
  for (let n = 2; Object.prototype.hasOwnProperty.call(out, k); n++) k = `${base}#${n}`;
  Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
}

/** `keepNums`: numbers are kept as they are (device/os/app contexts: memory, storage, screen sizes). */
function walk(value: unknown, key: string | null, ctx: Ctx, depth: number, keepNums = false): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return key && MONEY_KEY.test(key) ? REDACTED : scrubText(value, ctx.opts);
  if (typeof value === 'number') return keepNums ? value : scrubNumber(key, value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return NUM;
  if (typeof value !== 'object') return undefined; // functions, symbols
  if (depth > MAX_DEPTH) return '[Depth]';
  if (ctx.seen.has(value)) return '[Circular]';
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    ctx.seen.set(value, out);
    for (const v of value) out.push(walk(v, key, ctx, depth + 1, keepNums));
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
    const w = walk(v, k, ctx, depth + 1, keepNums);
    if (w !== undefined) setScrubbedKey(out, k, w, ctx);
  }
  return out;
}

// Contexts whose numbers are device facts (memory, storage, screen), not amounts or identifiers.
const DEVICE_CONTEXTS = new Set(['device', 'os', 'app']);
const TRACE_IDS = ['trace_id', 'span_id', 'parent_span_id'];
const HEX_ID = /^[0-9a-f]{16,32}$/i;

function scrubContexts(v: unknown, ctx: Ctx): unknown {
  if (!isObj(v)) return walk(v, null, ctx, 1);
  const out: Record<string, unknown> = {};
  ctx.seen.set(v, out);
  for (const k of Object.keys(v)) {
    if (CREDENTIAL_KEY.test(k) || PAYLOAD_KEY.test(k)) continue;
    let c: unknown;
    try {
      c = v[k];
    } catch {
      continue;
    }
    let w: unknown;
    if (DEVICE_CONTEXTS.has(k)) {
      w = walk(c, null, ctx, 2, true);
    } else if (k === 'trace' && isObj(c)) {
      // Trace and span ids are random hex, not user data: kept so events still group by trace.
      const isId = (tk: string) => TRACE_IDS.includes(tk) && typeof c[tk] === 'string' && HEX_ID.test(c[tk] as string);
      const rest: Record<string, unknown> = {};
      for (const tk of Object.keys(c)) if (!isId(tk)) rest[tk] = c[tk];
      const t = walk(rest, null, ctx, 2) as Record<string, unknown>;
      for (const id of TRACE_IDS) if (isId(id)) t[id] = c[id];
      w = t;
    } else {
      w = walk(c, null, ctx, 2);
    }
    if (w !== undefined) setScrubbedKey(out, k, w, ctx);
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
        const w = k === 'contexts' ? scrubContexts(v, ctx) : walk(v, k === 'extra' || k === 'tags' ? null : k, ctx, 1);
        if (w !== undefined) out[k] = w;
      }
    }
    return out as T;
  } catch {
    return null;
  }
}
