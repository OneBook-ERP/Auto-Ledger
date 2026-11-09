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

/** A booked entry with its day number and normalised party worked out once. */
type Prepared = { e: BookedEntry; order: number; day: number | null; party: string; ref: string };

/**
 * The booked entries indexed ONCE per check: by exact amount (paise) and by reference. Each pending item is then
 * compared only with the entries of its amount and its reference, so a check costs about pending + entries, not
 * pending x entries (2,000 x 4,500 froze the UI). `comparisons` counts entries looked at (tests use it as a bound).
 */
export type BookedIndex = { byAmount: Map<number, Prepared[]>; byRef: Map<string, Prepared[]>; comparisons: number };

export function indexBooked(entries: BookedEntry[]): BookedIndex {
  const byAmount = new Map<number, Prepared[]>();
  const byRef = new Map<string, Prepared[]>();
  entries.forEach((e, order) => {
    if (e.docstatus !== 0 && e.docstatus !== 1) return;
    const ref = clean(e.reference);
    const p: Prepared = { e, order, day: dayNumber(e.postingDate), party: e.party ? normalizeKey(e.party) : '', ref };
    const a = byAmount.get(e.amountMinor);
    if (a) a.push(p);
    else byAmount.set(e.amountMinor, [p]);
    if (ref !== '') {
      const r = byRef.get(ref);
      if (r) r.push(p);
      else byRef.set(ref, [p]);
    }
  });
  return { byAmount, byRef, comparisons: 0 };
}

/**
 * The best "possible duplicate" for `txn` among `entries`, or null.
 * - strong: the same reference (the txn's UTR), or the same amount on the same day to the same party;
 * - weak: the same amount at most 3 days apart when either side has no party, or the same party a few days apart.
 * Never matches: a cancelled entry, the opposite direction, a different amount (exact paise), a foreign-currency
 * amount (only a reference can match it), or the txn's own entry (recorded on the txn, or carrying its
 * `AL-<rawHash>` reference), or an entry `exclude` returns true for. Ties: a reference match first, then the closest
 * date, then strong over weak, then the earlier entry in `entries`.
 * For many items use `indexBooked` once and `findSimilarIn` per item (same answers).
 */
export function findSimilar(txn: PendingTxn, entries: BookedEntry[], exclude?: (e: BookedEntry) => boolean): SimilarHit | null {
  return findSimilarIn(txn, indexBooked(entries), exclude);
}

/** `findSimilar` against a prebuilt index: only the txn's amount bucket and reference bucket are looked at. */
export function findSimilarIn(txn: PendingTxn, index: BookedIndex, exclude?: (e: BookedEntry) => boolean): SimilarHit | null {
  const utr = clean(txn.utr);
  const byRef = utr !== '' ? (index.byRef.get(utr) ?? []) : [];
  const byAmount = index.byAmount.get(txn.amountMinor) ?? [];
  if (!byRef.length && !byAmount.length) return null;
  // Candidates in the original entry order (the last tie-break), each once.
  let candidates: Prepared[];
  if (!byRef.length) candidates = byAmount;
  else if (!byAmount.length) candidates = byRef;
  else {
    const seen = new Set<number>();
    candidates = [...byRef, ...byAmount].filter((p) => (seen.has(p.order) ? false : (seen.add(p.order), true)));
    candidates.sort((a, b) => a.order - b.order);
  }

  const own = new Set(txn.createdDocs.map((d) => `${d.doctype}\u0000${d.name}`));
  const ownRef = `AL-${txn.rawHash}`;
  const names = [txn.counterparty, txn.merchant].map((n) => (n ? normalizeKey(n) : '')).filter((n) => n !== '');
  const txnDay = dayNumber(txn.occurredOn);
  const rupees = txn.currency === 'INR';

  let best: { hit: SimilarHit; gap: number } | null = null;
  for (const p of candidates) {
    index.comparisons++;
    const e = p.e;
    if (own.has(`${e.doctype}\u0000${e.name}`) || p.ref === ownRef) continue;
    if (e.direction !== null && e.direction !== txn.direction) continue;
    if (exclude?.(e)) continue;
    const gap = txnDay !== null && p.day !== null ? Math.abs(txnDay - p.day) : Number.POSITIVE_INFINITY;

    let strength: SimilarHit['strength'] | null = null;
    const isRef = utr !== '' && p.ref === utr;
    if (isRef) strength = 'strong';
    else if (rupees && e.amountMinor === txn.amountMinor && gap <= SIMILAR_DAYS) {
      if (p.party === '' || names.length === 0) strength = 'weak';
      else if (names.includes(p.party)) strength = gap === 0 ? 'strong' : 'weak';
    }
    if (!strength) continue;

    const hit: SimilarHit = { entry: e, strength, why: isRef ? 'reference' : 'details' };
    if (!best || rank(hit, gap, best.hit, best.gap) < 0) best = { hit, gap };
  }
  return best ? best.hit : null;
}
