// Template set loading, validation and remote refresh (R27/R27b).
//
// The active set is the persisted `templates_json` setting when it is present, valid and not older than the
// bundled templates/idfc.json; otherwise the bundled copy. refreshTemplates fetches a newer set over https,
// validates it here in TS (shape, every regex, named groups, a built-in smoke parse), hands it to the native
// engine (which validates again and must accept it), and only then persists it. Any failure keeps the old
// set. Nothing here logs; nothing throws out of refreshTemplates or loadTemplates.
import type { TemplateSet, TxnKind } from '../core/types';
import { bundledTemplates, parseSms } from '../core/parser';
import type { Repo } from '../data/repo';

export const TEMPLATES_JSON_KEY = 'templates_json';
export const TEMPLATES_VERSION_KEY = 'templates_version';
export const REFRESH_TIMEOUT_MS = 10_000;
export const REFRESH_MAX_BYTES = 256 * 1024;

/** Named groups both engines understand (see templates/idfc.json `notes`). */
export const ALLOWED_GROUPS: ReadonlySet<string> = new Set([
  'amount', 'currency', 'day', 'month', 'year', 'time', 'last4', 'counterparty', 'utr', 'merchant', 'balance',
]);
const MONEY_KINDS: ReadonlySet<string> = new Set<TxnKind>(['ca_credit', 'ca_debit', 'neft_confirm', 'card_spend', 'card_si_paid']);
const IGNORE_REASONS: ReadonlySet<string> = new Set(['otp', 'si_notice', 'not_money', 'unknown_template']);

// Java accepts inline flag groups such as (?i) or (?-s:...); JS does not, and the engines must agree.
// (?: (?= (?! (?<name> (?<= (?<! are not flags.
const INLINE_FLAGS = /\(\?(?:[a-zA-Z]+(?:-[a-zA-Z]*)?|-[a-zA-Z]+)[):]/;
const NAMED_GROUP = /\(\?<([^>=!][^>]*)>/g;

/**
 * SYNTHETIC SMS in the real IDFC wording (no real account digits, balances or limits). A candidate set must
 * parse every one exactly like this before it is accepted: a bank credit and debit, an NEFT confirmation, a
 * card spend, a card SI payment and the OTP filter.
 */
export const SMOKE_SAMPLES: readonly {
  id: string; sender: string; body: string; receivedAt: number;
  expect: { ok: true; kind: TxnKind; amountMinor: number; accountLast4: string | null; occurredOn: string } | { ok: false; reason: 'otp' };
}[] = [
  {
    id: 'ca_credit',
    sender: 'JM-IDFCFB-S',
    body: 'Your A/C XXXXX991234 is credited with INR 1,500.00 on 03/11/26 09:15. Your new balance is INR 10,000.00. Team IDFC FIRST Bank',
    receivedAt: 1793880000000,
    expect: { ok: true, kind: 'ca_credit', amountMinor: 150000, accountLast4: '1234', occurredOn: '2026-11-03' },
  },
  {
    id: 'ca_debit',
    sender: 'AX-IDFCFB-S',
    body: 'Your A/C XXXXX991234 is debited by INR 2,500.00 on 04/11/26 12:35. New Bal :INR 7,500.00. Call us on 1800 10 888 for dispute. Team IDFC FIRST Bank',
    receivedAt: 1793880000000,
    expect: { ok: true, kind: 'ca_debit', amountMinor: 250000, accountLast4: '1234', occurredOn: '2026-11-04' },
  },
  {
    id: 'neft_confirm',
    sender: 'JD-IDFCFB-S',
    body: 'Your beneficiary PERSON_A has received Rs. 2,500.00 transferred via NEFT UTR IDFB0000A0000001.\nTeam IDFC First Bank.',
    receivedAt: 1793880000000, // 2026-11-05 in Asia/Kolkata; the body has no date
    expect: { ok: true, kind: 'neft_confirm', amountMinor: 250000, accountLast4: null, occurredOn: '2026-11-05' },
  },
  {
    id: 'card_spend',
    sender: 'JM-IDFCFB-S',
    body: 'Transaction Successful! INR 99.00 spent on your IDFC FIRST Bank Credit Card ending XX9876 at EXAMPLE STORE on 02 NOV 2026 at 10:05 AM Avbl Limit: INR 50000.00 If not done by you, call 1800 10 888 for dispute or to block your card SMS CCBLOCK 9876 to 5676732',
    receivedAt: 1793880000000,
    expect: { ok: true, kind: 'card_spend', amountMinor: 9900, accountLast4: '9876', occurredOn: '2026-11-02' },
  },
  {
    id: 'card_si_paid',
    sender: 'AD-IDFCFB-S',
    body: 'INR 499.00 for Example Media paid from your IDFC FIRST Bank Credit Card XX9876 on 01/11/2026 basis standing instruction (SI).\nManage SI on your card: https://example.invalid/si using the SiHub ID: AAAAAAAAAA',
    receivedAt: 1793880000000,
    expect: { ok: true, kind: 'card_si_paid', amountMinor: 49900, accountLast4: '9876', occurredOn: '2026-11-01' },
  },
  {
    id: 'otp',
    sender: 'VM-IDFCFB-S',
    body: '123456 is your OTP for IDFC FIRST Bank transaction of INR 100.00. Do not share it with anyone.',
    receivedAt: 1793880000000,
    expect: { ok: false, reason: 'otp' },
  },
];

/**
 * Constructs that compile in both JS and Java but mean different things (or nothing) in one of them:
 * \A \Z \z \h \p{ \P{ (JS without the u flag reads them as letters), [^] (JS: any char) and && inside a
 * character class (Java: intersection). Returns the first one found, or null.
 */
function nonPortable(p: string): string | null {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      const n = p[i + 1];
      if (n === 'A' || n === 'Z' || n === 'z' || n === 'h') return `\\${n}`;
      if ((n === 'p' || n === 'P') && p[i + 2] === '{') return `\\${n}{`;
      i++;
      continue;
    }
    if (!inClass) {
      if (c === '[') {
        if (p[i + 1] === '^' && p[i + 2] === ']') return '[^]';
        inClass = true;
        // A leading ] (or ^]) is a literal in Java; skip it so the class is not ended early.
        if (p[i + 1] === '^') i++;
        if (p[i + 1] === ']') i++;
      }
      continue;
    }
    if (c === '&' && p[i + 1] === '&') return '&& in a character class';
    if (c === ']') inClass = false;
  }
  return null;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;

function checkRegex(where: string, p: unknown): string | null {
  if (!nonEmpty(p)) return `${where} is missing or empty`;
  if (INLINE_FLAGS.test(p)) return `${where} uses inline flags`;
  const bad = nonPortable(p);
  if (bad) return `${where} uses ${bad}, which is not portable between the JS and Java engines`;
  let re: RegExp;
  try {
    re = new RegExp(p, 'i');
  } catch {
    return `${where} does not compile`;
  }
  if (re.test('')) return `${where} matches the empty string`;
  for (const m of p.matchAll(NAMED_GROUP)) {
    if (!ALLOWED_GROUPS.has(m[1])) return `${where} uses the unknown group ${m[1]}`;
  }
  return null;
}

function groupsOf(p: string): Set<string> {
  return new Set([...p.matchAll(NAMED_GROUP)].map((m) => m[1]));
}

function checkShape(s: Record<string, unknown>, activeVersion: number | undefined): string | null {
  const v = s.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return 'version must be a positive integer';
  if (activeVersion !== undefined && v <= activeVersion) return `version ${v} is not newer than the active version ${activeVersion}`;
  for (const k of ['otpPattern', 'moneyVerbPattern', 'amountPattern']) {
    const err = checkRegex(k, s[k]);
    if (err) return err;
  }
  if (s.notes !== undefined && !(Array.isArray(s.notes) && s.notes.every((n) => typeof n === 'string'))) {
    return 'notes must be a list of strings';
  }
  if (!Array.isArray(s.banks) || s.banks.length === 0) return 'banks must be a non-empty list';
  for (const [bi, b] of s.banks.entries()) {
    const at = `banks[${bi}]`;
    if (!isObj(b)) return `${at} is not an object`;
    if (!nonEmpty(b.id)) return `${at}.id is missing`;
    if (!nonEmpty(b.senderPattern)) return `${at}.senderPattern is missing or empty`;
    if (!Array.isArray(b.templates) || b.templates.length === 0) return `${at}.templates must be a non-empty list`;
    for (const [ti, t] of b.templates.entries()) {
      const tat = `${at}.templates[${ti}]`;
      if (!isObj(t)) return `${tat} is not an object`;
      if (!nonEmpty(t.id)) return `${tat}.id is missing`;
      if (typeof t.kind !== 'string' || !(MONEY_KINDS.has(t.kind) || t.kind === 'ignore')) return `${tat}.kind is not a known kind`;
      if (t.accountType !== 'bank' && t.accountType !== 'card') return `${tat}.accountType must be bank or card`;
      if (t.direction !== undefined && t.direction !== 'in' && t.direction !== 'out') return `${tat}.direction must be in or out`;
      if (t.ignoreReason !== undefined && !(typeof t.ignoreReason === 'string' && IGNORE_REASONS.has(t.ignoreReason))) {
        return `${tat}.ignoreReason is not a known reason`;
      }
      const err = checkRegex(`${tat}.regex`, t.regex);
      if (err) return err;
      if (MONEY_KINDS.has(t.kind) && !groupsOf(t.regex as string).has('amount')) return `${tat}.regex has no amount group`;
    }
  }
  return null;
}

function smokeCheck(set: TemplateSet): string | null {
  for (const s of SMOKE_SAMPLES) {
    const r = parseSms(s.sender, s.body, s.receivedAt, set);
    const e = s.expect;
    const good = e.ok
      ? r.ok && r.txn.kind === e.kind && r.txn.amountMinor === e.amountMinor
        && r.txn.accountLast4 === e.accountLast4 && r.txn.occurredOn === e.occurredOn
      : !r.ok && r.reason === e.reason;
    if (!good) return `smoke check failed on sample ${s.id}`;
  }
  return null;
}

/**
 * Validates a template set (an object, or its JSON text). With `activeVersion`, the set's version must be
 * greater than it. Checks the shape, that every pattern compiles case-insensitively without inline flags,
 * does not match the empty string and uses only ALLOWED_GROUPS, and runs the SMOKE_SAMPLES through it.
 */
export function validateTemplateSet(
  json: unknown,
  opts: { activeVersion?: number } = {},
): { ok: true; set: TemplateSet } | { ok: false; reason: string } {
  let v = json;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return { ok: false, reason: 'not valid JSON' };
    }
  }
  if (!isObj(v)) return { ok: false, reason: 'not an object' };
  try {
    const shape = checkShape(v, opts.activeVersion);
    if (shape) return { ok: false, reason: shape };
    const set = v as unknown as TemplateSet;
    const smoke = smokeCheck(set);
    if (smoke) return { ok: false, reason: smoke };
    return { ok: true, set };
  } catch {
    return { ok: false, reason: 'the template set could not be checked' };
  }
}

/** The template set the pipeline parses with: a valid persisted override not older than the bundled set, else the bundled set. */
export async function loadTemplates(repo: Repo): Promise<TemplateSet> {
  try {
    const raw = await repo.getSetting(TEMPLATES_JSON_KEY);
    if (raw) {
      const r = validateTemplateSet(raw);
      if (r.ok && r.set.version >= bundledTemplates.version) return r.set;
    }
  } catch {
    // fall through to the bundled copy
  }
  return bundledTemplates;
}

/** Version of the set loadTemplates returns. */
export async function activeTemplateVersion(repo: Repo): Promise<number> {
  return (await loadTemplates(repo)).version;
}

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_r, reject) => {
    timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error('timeout'));
    }, REFRESH_TIMEOUT_MS);
  });
  const work = (async () => {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (res.url && !/^https:\/\//i.test(res.url)) throw new Error('redirected off https');
    const len = Number(res.headers?.get?.('content-length') ?? NaN);
    if (Number.isFinite(len) && len > REFRESH_MAX_BYTES) throw new Error('too large');
    const text = await res.text();
    if (utf8Length(text) > REFRESH_MAX_BYTES) throw new Error('too large');
    return text;
  })();
  work.catch(() => undefined); // a late rejection after the timeout must not go unhandled
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches a template set from `url` (https only, 10 s timeout, 256 KB cap). A set whose version equals the
 * active one is 'unchanged'. A valid newer set is passed to native setTemplates (which must return true) and
 * then persisted ('updated'). Anything else keeps the old set and returns 'failed'. Never throws.
 */
export async function refreshTemplates(deps: {
  url: string;
  fetchImpl?: typeof fetch;
  repo: Repo;
  native: { setTemplates(json: string): Promise<boolean> };
}): Promise<'updated' | 'unchanged' | 'failed'> {
  try {
    if (typeof deps.url !== 'string' || !/^https:\/\/[^/\s]+/i.test(deps.url)) return 'failed';
    const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const text = await fetchText(deps.url, fetchImpl);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return 'failed';
    }
    const active = await activeTemplateVersion(deps.repo);
    if (isObj(parsed) && parsed.version === active) return 'unchanged';
    const r = validateTemplateSet(parsed, { activeVersion: active });
    if (!r.ok) return 'failed';
    if ((await deps.native.setTemplates(text)) !== true) return 'failed';
    await deps.repo.setSetting(TEMPLATES_JSON_KEY, text);
    await deps.repo.setSetting(TEMPLATES_VERSION_KEY, String(r.set.version));
    return 'updated';
  } catch {
    return 'failed';
  }
}
