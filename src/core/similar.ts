// "Looks already booked" match between a pending txn and entries already in ERPNext. Pure. WARN ONLY: the
// result never blocks or hides anything; duplicate safety for the app's own writes is the runner's (20A).
import { normalizeKey } from './suggest';
import type { PendingTxn } from './types';

/** An ERPNext document already booked (draft or submitted). Money in paise, company currency. */
export type BookedEntry = {
  doctype: string;
  name: string;
  /** YYYY-MM-DD */
  postingDate: string;
  amountMinor: number;
  /** null when the document has no single direction (a Journal Entry, an internal transfer). */
  direction: 'in' | 'out' | null;
  party: string | null;
  reference: string | null;
  docstatus: 0 | 1;
};

/** `why`: 'reference' when the txn's UTR is the entry's reference (always strong); else 'details' (amount, date, name). */
export type SimilarHit = { entry: BookedEntry; strength: 'strong' | 'weak'; why: 'reference' | 'details' };

/** Same amount at most this many days apart counts as similar. */
export const SIMILAR_DAYS = 3;

const DAY_MS = 86_400_000;

/** Whole days since the epoch for a YYYY-MM-DD string, or null when it is not one. */
export function dayNumber(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(ms) ? Math.round(ms / DAY_MS) : null;
}

const clean = (s: string | null | undefined) => (s ?? '').trim();

/** Negative when `a` beats `b`: reference first, then the closest date, then strong over weak; else 0 (keep the earlier). */
function rank(a: SimilarHit, gapA: number, b: SimilarHit, gapB: number): number {
  const ref = (h: SimilarHit) => (h.why === 'reference' ? 0 : 1);
  const str = (h: SimilarHit) => (h.strength === 'strong' ? 0 : 1);
  if (ref(a) !== ref(b)) return ref(a) - ref(b);
  if (gapA !== gapB) return gapA < gapB ? -1 : 1;
  return str(a) - str(b);
}

/**
 * The best "possible duplicate" for `txn` among `entries`, or null.
 * - strong: the same reference (the txn's UTR), or the same amount on the same day to the same party;
 * - weak: the same amount at most 3 days apart when either side has no party, or the same party a few days apart.
 * Never matches: a cancelled entry, the opposite direction, a different amount (exact paise), a foreign-currency
 * amount (only a reference can match it), or the txn's own entry (recorded on the txn, or carrying its
 * `AL-<rawHash>` reference), or an entry `exclude` returns true for. Ties: a reference match first, then the closest
 * date, then strong over weak, then the earlier entry in `entries`.
 */
export function findSimilar(txn: PendingTxn, entries: BookedEntry[], exclude?: (e: BookedEntry) => boolean): SimilarHit | null {
  const own = new Set(txn.createdDocs.map((d) => `${d.doctype}\u0000${d.name}`));
  const ownRef = `AL-${txn.rawHash}`;
  const utr = clean(txn.utr);
  const names = [txn.counterparty, txn.merchant].map((n) => (n ? normalizeKey(n) : '')).filter((n) => n !== '');
  const txnDay = dayNumber(txn.occurredOn);
  const rupees = txn.currency === 'INR';

  let best: { hit: SimilarHit; gap: number } | null = null;
  for (const e of entries) {
    if (e.docstatus !== 0 && e.docstatus !== 1) continue;
    const ref = clean(e.reference);
    if (own.has(`${e.doctype}\u0000${e.name}`) || ref === ownRef) continue;
    if (e.direction !== null && e.direction !== txn.direction) continue;
    if (exclude?.(e)) continue;
    const entryDay = dayNumber(e.postingDate);
    const gap = txnDay !== null && entryDay !== null ? Math.abs(txnDay - entryDay) : Number.POSITIVE_INFINITY;

    let strength: SimilarHit['strength'] | null = null;
    const byRef = utr !== '' && ref === utr;
    if (byRef) strength = 'strong';
    else if (rupees && e.amountMinor === txn.amountMinor && gap <= SIMILAR_DAYS) {
      const party = e.party ? normalizeKey(e.party) : '';
      if (party === '' || names.length === 0) strength = 'weak';
      else if (names.includes(party)) strength = gap === 0 ? 'strong' : 'weak';
    }
    if (!strength) continue;

    const hit: SimilarHit = { entry: e, strength, why: byRef ? 'reference' : 'details' };
    if (!best || rank(hit, gap, best.hit, best.gap) < 0) best = { hit, gap };
  }
  return best ? best.hit : null;
}
