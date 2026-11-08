import type { Correlation, ParsedTxn, PendingTxn } from './types';

const NEFT_WINDOW_MS = 48 * 3600_000;
const CARD_WINDOW_MS = 2 * 24 * 3600_000;
const MIN_COMMON_PREFIX = 5;

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// Same merchant if normalised names are equal, one contains the other
// ("facebook" / "facebooksi"), or they share a >=5 char prefix ("googleads" /
// "googleservis": the real card_si_paid and card_spend names differ). The
// amount, currency and 2-day window checks keep the loose name rule safe.
function sameMerchant(a: string | null, b: string | null): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x) || commonPrefix(x, y) >= MIN_COMMON_PREFIX;
}

function matchNeft(ex: PendingTxn, inc: ParsedTxn): boolean {
  if (ex.kind !== 'ca_debit') return false;
  if (inc.utr && ex.utr) return inc.utr === ex.utr;
  return ex.utr === null && ex.amountMinor === inc.amountMinor
    && Math.abs(ex.receivedAt - inc.receivedAt) <= NEFT_WINDOW_MS;
}

function matchCard(ex: PendingTxn, inc: ParsedTxn): boolean {
  const pair = (ex.kind === 'card_si_paid' && inc.kind === 'card_spend')
    || (ex.kind === 'card_spend' && inc.kind === 'card_si_paid');
  return pair && ex.amountMinor === inc.amountMinor && ex.currency === inc.currency
    && Math.abs(ex.receivedAt - inc.receivedAt) <= CARD_WINDOW_MS
    && sameMerchant(ex.merchant, inc.merchant);
}

export function correlate(existing: PendingTxn[], incoming: ParsedTxn): Correlation {
  // Same rawHash (no timestamp in it) means the same SMS delivered twice.
  const same = existing.find((e) => e.rawHash === incoming.rawHash);
  if (same) return { action: 'drop_duplicate', of: same.id };

  for (const ex of existing) {
    if (ex.direction !== incoming.direction || ex.accountType !== incoming.accountType) continue;

    if (incoming.kind === 'neft_confirm' && matchNeft(ex, incoming)) {
      const patch: Partial<ParsedTxn> = {};
      if (ex.counterparty === null && incoming.counterparty !== null) patch.counterparty = incoming.counterparty;
      if (ex.utr === null && incoming.utr !== null) patch.utr = incoming.utr;
      // Nothing to add (the debit SMS already carried the utr and name): duplicate.
      if (Object.keys(patch).length === 0) return { action: 'drop_duplicate', of: ex.id };
      return { action: 'enrich', target: ex.id, patch };
    }

    if (matchCard(ex, incoming)) {
      // The card_spend SMS carries the time and last-4 that card_si_paid lacks.
      // If the card_spend arrives second, enrich the existing card_si_paid with
      // those; if nothing is missing, or the card_spend came first, it is a
      // plain duplicate.
      if (incoming.kind === 'card_spend') {
        const patch: Partial<ParsedTxn> = {};
        if (ex.accountLast4 === null && incoming.accountLast4 !== null) patch.accountLast4 = incoming.accountLast4;
        if (ex.occurredTime === null && incoming.occurredTime !== null) patch.occurredTime = incoming.occurredTime;
        if (Object.keys(patch).length > 0) return { action: 'enrich', target: ex.id, patch };
      }
      return { action: 'drop_duplicate', of: ex.id };
    }
  }
  return { action: 'insert' };
}
