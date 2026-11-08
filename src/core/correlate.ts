import type { Correlation, ParsedTxn, PendingTxn } from './types';

const NEFT_WINDOW_MS = 48 * 3600_000;
const CARD_WINDOW_MS = 2 * 24 * 3600_000;
const MIN_MERCHANT_LEN = 5;
const MIN_COMMON_PREFIX = 5;

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Same merchant if normalised names are equal, the shorter (>= 5 chars) is
// contained in the longer ("facebook" / "facebooksi"), or they share a >= 5
// char prefix ("googleads" / "googleservis": the real card_si_paid and
// card_spend names differ). Amount, currency and the 2-day window keep it safe.
function sameMerchant(a: string | null, b: string | null): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= MIN_MERCHANT_LEN && long.includes(short)) return true;
  return commonPrefix(x, y) >= MIN_COMMON_PREFIX;
}

const gap = (a: PendingTxn, b: ParsedTxn) => Math.abs(a.receivedAt - b.receivedAt);

// Selection policy (deterministic): candidates must be unpaired
// (mergedCount === 1). Pass 1 takes an exact utr equality match; pass 2 the
// amount/window (cards: merchant) fallback. Within a pass the candidate with
// the smallest |receivedAt difference| wins, ties broken by lowest id.
function pick(cands: PendingTxn[], inc: ParsedTxn): PendingTxn | undefined {
  return [...cands].sort((a, b) => gap(a, inc) - gap(b, inc) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

function findNeftPartner(existing: PendingTxn[], inc: ParsedTxn): PendingTxn | undefined {
  const partnerKind = inc.kind === 'neft_confirm' ? 'ca_debit' : 'ca_debit' === inc.kind ? 'neft_confirm' : null;
  if (!partnerKind) return undefined;
  const pool = existing.filter((e) => e.kind === partnerKind && e.mergedCount === 1
    && e.direction === inc.direction && e.accountType === inc.accountType);
  const byUtr = inc.utr ? pick(pool.filter((e) => e.utr === inc.utr), inc) : undefined;
  if (byUtr) return byUtr;
  return pick(pool.filter((e) => !(e.utr && inc.utr) && e.amountMinor === inc.amountMinor
    && gap(e, inc) <= NEFT_WINDOW_MS), inc);
}

function findCardPartner(existing: PendingTxn[], inc: ParsedTxn): PendingTxn | undefined {
  const partnerKind = inc.kind === 'card_spend' ? 'card_si_paid' : inc.kind === 'card_si_paid' ? 'card_spend' : null;
  if (!partnerKind) return undefined;
  return pick(existing.filter((e) => e.kind === partnerKind && e.mergedCount === 1
    && e.direction === inc.direction && e.accountType === inc.accountType
    && e.amountMinor === inc.amountMinor && e.currency === inc.currency
    && gap(e, inc) <= CARD_WINDOW_MS && sameMerchant(e.merchant, inc.merchant)), inc);
}

export function correlate(existing: PendingTxn[], incoming: ParsedTxn): Correlation {
  // Same rawHash (no timestamp in it) means the same SMS delivered twice.
  const same = existing.find((e) => e.rawHash === incoming.rawHash);
  if (same) return { action: 'drop_duplicate', of: same.id, reason: 'same_sms' };

  if (incoming.kind === 'neft_confirm') {
    const ex = findNeftPartner(existing, incoming);
    if (ex) {
      const patch: Partial<ParsedTxn> = {};
      if (ex.counterparty === null && incoming.counterparty !== null) patch.counterparty = incoming.counterparty;
      if (ex.utr === null && incoming.utr !== null) patch.utr = incoming.utr;
      // Nothing to add (the debit SMS already carried utr and name).
      if (Object.keys(patch).length === 0) return { action: 'drop_duplicate', of: ex.id, reason: 'empty_patch' };
      return { action: 'enrich', target: ex.id, patch };
    }
  } else if (incoming.kind === 'ca_debit') {
    // Confirmation arrived first: make that item the canonical debit.
    const ex = findNeftPartner(existing, incoming);
    if (ex) {
      const patch: Partial<ParsedTxn> = { kind: 'ca_debit', occurredOn: incoming.occurredOn };
      if (incoming.occurredTime !== null) patch.occurredTime = incoming.occurredTime;
      if (incoming.accountLast4 !== null) patch.accountLast4 = incoming.accountLast4;
      if (incoming.balanceMinor !== null) patch.balanceMinor = incoming.balanceMinor;
      return { action: 'enrich', target: ex.id, patch };
    }
  } else {
    const ex = findCardPartner(existing, incoming);
    if (ex) {
      // The card_spend SMS carries the time and last-4 that card_si_paid lacks.
      // If the card_spend arrives second, enrich the existing card_si_paid with
      // those; if nothing is missing, or the card_spend came first, it is a
      // plain pairing duplicate.
      if (incoming.kind === 'card_spend') {
        const patch: Partial<ParsedTxn> = {};
        if (ex.accountLast4 === null && incoming.accountLast4 !== null) patch.accountLast4 = incoming.accountLast4;
        if (ex.occurredTime === null && incoming.occurredTime !== null) patch.occurredTime = incoming.occurredTime;
        if (Object.keys(patch).length > 0) return { action: 'enrich', target: ex.id, patch };
      }
      return { action: 'drop_duplicate', of: ex.id, reason: 'paired' };
    }
  }
  return { action: 'insert' };
}
