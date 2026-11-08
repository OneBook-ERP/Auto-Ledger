// Linking the two legs of one own-account transfer (R54). When both accounts are read by AutoLedger, each
// leg gets its own message, often with different references (IDFC's short credit format has no UTR, so it
// falls back to AL-<rawHash>). The second leg answered must reuse the FIRST leg's reference so the runner
// finds and adopts that leg's Payment Entry instead of booking the transfer twice. Symmetric: it does not
// matter which leg is answered first, and nothing extra is stored when the first leg is answered.
import { txnReference } from '../core/plan';
import type { AccountMapping, PendingTxn } from '../core/types';
import type { Repo } from '../data/repo';
import { resolveMapping } from '../ingest/pipeline';
import { shortAccount } from './format';

export const COUNTERPART_WINDOW_MS = 3 * 86_400_000;
export const SEVERAL_TRANSFERS_WARNING = 'Several matching transfers were found. Check ERPNext for duplicates after creating.';

export type CounterpartLink =
  | { status: 'none' }
  | { status: 'linked'; reference: string; txnId: string; docName: string; counterLabel: string }
  | { status: 'several'; count: number };

const paymentEntry = (t: PendingTxn) => t.createdDocs.find((d) => d.doctype === 'Payment Entry');

/** Already-answered txns that look like the other leg of `txn` on `counter`. Pure. */
export function counterpartCandidates(txn: PendingTxn, counter: AccountMapping, txns: PendingTxn[], mappings: AccountMapping[]): PendingTxn[] {
  if (txn.currency !== 'INR') return [];
  return txns.filter((t) =>
    t.id !== txn.id
    && (t.state === 'created' || t.state === 'submitted')
    && t.direction !== txn.direction
    && t.currency === 'INR'
    && t.amountMinor === txn.amountMinor
    && Math.abs(t.receivedAt - txn.receivedAt) <= COUNTERPART_WINDOW_MS
    && resolveMapping(mappings, t)?.bankAccount === counter.bankAccount
    && !!paymentEntry(t));
}

/**
 * `counter`: the mapping of the OTHER account of the transfer, or null when that account is not read by the
 * app (then its leg can never be in the repo, so nothing is searched).
 */
export async function findCounterpartLeg(txn: PendingTxn, counter: AccountMapping | null, repo: Repo, mappings: AccountMapping[]): Promise<CounterpartLink> {
  if (!counter || txn.currency !== 'INR') return { status: 'none' };
  const [created, submitted] = await Promise.all([repo.listPending('created'), repo.listPending('submitted')]);
  const hits = counterpartCandidates(txn, counter, [...created, ...submitted], mappings);
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1) return { status: 'several', count: hits.length };
  const leg = hits[0];
  return { status: 'linked', reference: txnReference(leg), txnId: leg.id, docName: paymentEntry(leg)!.name, counterLabel: shortAccount(counter.bankAccount) };
}

/** The mapping of the other account of a transfer draft (debit: toAccount; credit: the source if it is read). */
export function counterMappingOf(
  d: { action?: string; toAccount?: AccountMapping; fromAccount?: { bankAccount: string } },
  direction: 'in' | 'out',
  mappings: AccountMapping[],
): AccountMapping | null {
  if (d.action !== 'transfer') return null;
  if (direction === 'out') return d.toAccount ?? null;
  return d.fromAccount ? (mappings.find((m) => m.bankAccount === d.fromAccount!.bankAccount) ?? null) : null;
}
