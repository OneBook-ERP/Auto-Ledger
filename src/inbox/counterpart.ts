// Linking the two legs of one own-account transfer (R54, R57). When both accounts are read by AutoLedger,
// each leg gets its own message, often with different references (IDFC's short credit format has no UTR, so
// it falls back to AL-<rawHash>). The second leg answered must reuse the reference that is ACTUALLY on the
// first leg's Payment Entry, so the runner finds and adopts it instead of booking the transfer twice.
//
// A candidate is qualified from its STORED PLAN, never from amount and date alone: its outbox item must hold
// an Internal Transfer Payment Entry with the same paid_from, paid_to and amount as this leg's own plan. A leg
// that is already paired is excluded (its document was adopted, is listed by another txn, or its reference is
// in another txn's plan). Symmetric: whichever leg is answered first; nothing extra is stored for it. A first
// leg that is still queued (answered offline) counts too: its plan already carries the reference.
import type { AccountMapping, ActionPlan, OutboxOp, PendingTxn } from '../core/types';
import type { Repo } from '../data/repo';
import { resolveMapping } from '../ingest/pipeline';
import { shortAccount } from './format';

export const COUNTERPART_WINDOW_MS = 3 * 86_400_000;
export const SEVERAL_TRANSFERS_WARNING = 'Several matching transfers were found. Check ERPNext for duplicates after creating.';

export type CounterpartLink =
  | { status: 'none' }
  /** `docName` is null while the other leg's answer is still waiting to be sent. */
  | { status: 'linked'; reference: string; txnId: string; docName: string | null; counterLabel: string }
  | { status: 'several'; count: number };

export type TransferLeg = { paidFrom: string; paidTo: string; amount: number; reference: string };

type Body = Record<string, unknown>;
const transferStep = (plan: ActionPlan) =>
  plan.steps.find((s) => s.kind === 'create_doc' && s.doctype === 'Payment Entry' && s.body.payment_type === 'Internal Transfer');

/** The Internal Transfer a plan books, or null when it books something else. */
export function transferLegOf(plan: ActionPlan): TransferLeg | null {
  const s = transferStep(plan);
  if (!s) return null;
  const b = s.body as Body;
  if (typeof b.paid_from !== 'string' || typeof b.paid_to !== 'string' || typeof b.reference_no !== 'string') return null;
  return { paidFrom: b.paid_from, paidTo: b.paid_to, amount: Number(b.paid_amount), reference: b.reference_no };
}

export type Candidate = { txn: PendingTxn; reference: string; docName: string | null };

/**
 * Pure. `own`: the leg this txn would book (its plan WITHOUT an override). `txns`: every local txn;
 * `items`: every 'pending' or 'done' outbox item (repo.listActiveOutbox).
 */
export function counterpartCandidates(
  txn: PendingTxn, counter: AccountMapping, own: TransferLeg, txns: PendingTxn[], items: OutboxOp[], mappings: AccountMapping[],
): Candidate[] {
  if (txn.currency !== 'INR') return [];
  const byTxn = new Map<string, OutboxOp[]>();
  for (const o of items) byTxn.set(o.txnId, [...(byTxn.get(o.txnId) ?? []), o]);
  const out: Candidate[] = [];
  for (const t of txns) {
    if (t.id === txn.id || t.direction === txn.direction || t.currency !== 'INR' || t.amountMinor !== txn.amountMinor) continue;
    if (Math.abs(t.receivedAt - txn.receivedAt) > COUNTERPART_WINDOW_MS) continue;
    if (resolveMapping(mappings, t)?.bankAccount !== counter.bankAccount) continue;
    const mine = byTxn.get(t.id) ?? [];
    const answered = t.state === 'created' || t.state === 'submitted';
    // The plan behind its current answer: the finished item for an answered txn, the queued one for a new txn.
    const item = [...mine].reverse().find((o) => (answered ? o.status === 'done' : t.state === 'new' && o.status === 'pending'));
    if (!item) continue;
    const leg = transferLegOf(item.plan);
    if (!leg || leg.paidFrom !== own.paidFrom || leg.paidTo !== own.paidTo || leg.amount !== own.amount) continue;
    let docName: string | null = null;
    if (answered) {
      const pe = t.createdDocs.find((d) => d.doctype === 'Payment Entry');
      // Its entry must be its own (an adopter is already the second leg of some pair).
      if (!pe || pe.adopted) continue;
      docName = pe.name;
      const elsewhere = txns.some((o) => o.id !== t.id && o.id !== txn.id && o.createdDocs.some((d) => d.doctype === 'Payment Entry' && d.name === pe.name));
      if (elsewhere) continue;
    }
    // Its reference already used by another txn's current plan: that pair is complete.
    const used = items.some((o) => o.txnId !== t.id && o.txnId !== txn.id && transferLegOf(o.plan)?.reference === leg.reference);
    if (used) continue;
    out.push({ txn: t, reference: leg.reference, docName });
  }
  return out;
}

/**
 * `counter`: the mapping of the OTHER account of the transfer, or null when that account is not read by the
 * app (its leg can never be local, so nothing is searched). `ownPlan`: this txn's plan without an override.
 */
export async function findCounterpartLeg(
  txn: PendingTxn, counter: AccountMapping | null, ownPlan: ActionPlan, repo: Repo, mappings: AccountMapping[],
): Promise<CounterpartLink> {
  const own = transferLegOf(ownPlan);
  if (!counter || !own || txn.currency !== 'INR') return { status: 'none' };
  const [txns, items] = await Promise.all([repo.listPending(), repo.listActiveOutbox()]);
  const hits = counterpartCandidates(txn, counter, own, txns, items, mappings);
  if (hits.length === 0) return { status: 'none' };
  if (hits.length > 1) return { status: 'several', count: hits.length };
  const h = hits[0];
  return { status: 'linked', reference: h.reference, txnId: h.txn.id, docName: h.docName, counterLabel: shortAccount(counter.bankAccount) };
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
