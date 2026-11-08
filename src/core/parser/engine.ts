import type { IgnoreReason, ParseResult, ParsedTxn, TemplateSet } from '../types';
import { parseMinor } from '../money';

/*
 * Template engine. templates/idfc.json is shared with the Kotlin engine (Task 8), so
 * regexes use only syntax valid in both JS and Java, compile case-insensitively, and use
 * only these named groups: amount, currency, day, month, year, time, last4, counterparty,
 * utr, merchant, balance.
 *
 * The OTP, money-verb and amount heuristics are in the template file (otpPattern,
 * moneyVerbPattern, amountPattern) so Kotlin reads one source; see its `notes`.
 * parseSms is total: any fault yields unknown_template, never an exception.
 *
 * Order: (1) OTP check; (2) first bank whose senderPattern is a substring of the sender,
 * none -> unknown_template; (3) first template whose regex matches wins ('ignore' kind
 * returns its ignoreReason); (4) a body from a known sender matching no template is
 * 'unknown_template' if it still looks like a money movement (money-verb + amount), so a
 * new bank format is flagged instead of silently lost; otherwise 'not_money'
 * (limit alerts, statements, marketing, KYC).
 */


const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const pad = (n: number | string) => String(n).padStart(2, '0');

function monthNumber(m: string): number {
  if (/^\d+$/.test(m)) return parseInt(m, 10);
  const i = MONTHS.indexOf(m.slice(0, 3).toLowerCase());
  if (i < 0) throw new Error(`bad month ${m}`);
  return i + 1;
}

/** 12h or 24h "h:mm [AM|PM]" to "HH:mm". */
function normTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*([AP]M)?$/i.exec(t.trim());
  if (!m) throw new Error(`bad time ${t}`);
  let h = parseInt(m[1], 10);
  if (h > 23 || parseInt(m[2], 10) > 59) throw new Error(`bad time ${t}`);
  if (m[3]) {
    const pm = m[3].toUpperCase() === 'PM';
    h = (h % 12) + (pm ? 12 : 0);
  }
  return `${pad(h)}:${m[2]}`;
}

/** YYYY-MM-DD of an epoch in Asia/Kolkata (UTC+5:30, no DST). */
function istDate(ms: number): string {
  return new Date(ms + 19800000).toISOString().slice(0, 10);
}

/** cyrb53: pure-JS 53-bit non-crypto hash, returned as a string. */
function cyrb53(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return String(4294967296 * (2097151 & h2) + (h1 >>> 0));
}

export function rawHash(sender: string, body: string): string {
  return cyrb53(sender + '\n' + body.replace(/\s+/g, ' ').trim());
}

function normCurrency(c: string | undefined): string {
  if (!c) return 'INR';
  return /^rs/i.test(c) ? 'INR' : c.toUpperCase();
}

/**
 * Unicode space characters (Zs separators, BOM, line/paragraph separators) become a plain
 * space, so JS and Java (whose \s is ASCII-only) see the same text. Same set as Kotlin.
 */
const UNICODE_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF\u2028\u2029]/g;

export function parseSms(
  sender: string,
  body: string,
  receivedAt: number,
  templates: TemplateSet,
): ParseResult {
  try {
    return parseSmsUnsafe(sender, body, receivedAt, templates);
  } catch {
    return { ok: false, reason: 'unknown_template' };
  }
}

function parseSmsUnsafe(
  sender: string,
  body: string,
  receivedAt: number,
  templates: TemplateSet,
): ParseResult {
  body = body.replace(UNICODE_SPACES, ' ');
  if (new RegExp(templates.otpPattern, 'i').test(body)) return { ok: false, reason: 'otp' };

  const bank = templates.banks.find((b) => sender.includes(b.senderPattern));
  if (!bank) return { ok: false, reason: 'unknown_template' };

  for (const tpl of bank.templates) {
    const m = new RegExp(tpl.regex, 'i').exec(body);
    if (!m) continue;
    if (tpl.kind === 'ignore') {
      return { ok: false, reason: (tpl.ignoreReason ?? 'not_money') as IgnoreReason };
    }
    const g = m.groups ?? {};
    let occurredOn: string;
    if (g.day && g.month && g.year) {
      const y = g.year.length === 2 ? 2000 + parseInt(g.year, 10) : parseInt(g.year, 10);
      const mo = monthNumber(g.month);
      const dd = parseInt(g.day, 10);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31) throw new Error('bad date');
      occurredOn = `${y}-${pad(mo)}-${pad(dd)}`;
    } else {
      occurredOn = istDate(receivedAt);
    }
    const txn: ParsedTxn = {
      kind: tpl.kind,
      direction: tpl.direction ?? 'out',
      amountMinor: parseMinor(g.amount),
      currency: normCurrency(g.currency),
      occurredOn,
      occurredTime: g.time ? normTime(g.time) : null,
      accountType: tpl.accountType,
      accountLast4: g.last4 ?? null,
      counterparty: g.counterparty ? g.counterparty.trim() : null,
      utr: g.utr ?? null,
      merchant: g.merchant ? g.merchant.trim() : null,
      balanceMinor: g.balance ? parseMinor(g.balance) : null,
      sender,
      receivedAt,
      rawHash: rawHash(sender, body),
    };
    return { ok: true, txn };
  }

  return {
    ok: false,
    reason: new RegExp(templates.moneyVerbPattern, 'i').test(body) &&
      new RegExp(templates.amountPattern, 'i').test(body) ? 'unknown_template' : 'not_money',
  };
}
