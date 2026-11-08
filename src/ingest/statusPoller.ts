// Submit-status poller (spec 7.10): finds out whether the accountant submitted, cancelled or removed the drafts
// AutoLedger created. Never submits or deletes anything and never throws. Every write runs under the runner's
// per-txn lock and re-reads the txn first, so a poll cannot race runPlan, Undo or a field update (R32).
import type { PendingTxn } from '../core/types';
import type { Repo } from '../data/repo';
import { withTxnLock, type ErpOps } from '../outbox/runner';

export type PollDeps = { repo: Repo; erp: Pick<ErpOps, 'getDocStatuses'>; now?: () => number };
export type PollResult = { checked: number; submitted: number; cancelled: number; missing: number };

/** docstatus recorded for a document that ERPNext no longer returns (deleted or not accessible). */
export const DOC_MISSING = -1;

const key = (d: { doctype: string; name: string }) => `${d.doctype}:${d.name}`;

/**
 * One batched status lookup for every 'created' txn. Per document the answer is recorded as docstatus 0/1/2,
 * or -1 when ERPNext does not return it. A txn becomes 'submitted' only when ALL its documents are 1; a
 * cancelled or missing document is recorded and the state is left alone. A network/auth error aborts quietly.
 * Counts: checked and submitted are txns; cancelled and missing are documents whose record changed this poll.
 */
export async function pollStatuses(deps: PollDeps): Promise<PollResult> {
  const out: PollResult = { checked: 0, submitted: 0, cancelled: 0, missing: 0 };
  try {
    const waiting = (await deps.repo.listPending('created')).filter((t) => t.createdDocs.length > 0);
    if (!waiting.length) return out;
    const st = await deps.erp.getDocStatuses(waiting.flatMap((t) => t.createdDocs.map(({ doctype, name }) => ({ doctype, name }))));
    for (const t of waiting) {
      try {
        const r = await withTxnLock(t.id, () => apply(deps.repo, t.id, st));
        if (!r) continue;
        out.checked += 1;
        out.submitted += r.submitted ? 1 : 0;
        out.cancelled += r.cancelled;
        out.missing += r.missing;
      } catch {
        // a local write failure for one txn must not stop the others
      }
    }
  } catch {
    // offline, signed out, server error: nothing was changed; the next poll tries again
  }
  return out;
}

async function apply(repo: Repo, id: string, st: Record<string, number>) {
  const cur = await repo.getPending(id);
  // Undone, submitted by another path or otherwise changed since the list was read: leave it alone.
  if (!cur || cur.state !== 'created' || !cur.createdDocs.length) return null;
  let cancelled = 0;
  let missing = 0;
  const docs = cur.createdDocs.map((d) => {
    const ds = st[key(d)] ?? DOC_MISSING;
    if (ds === 2 && d.docstatus !== 2) cancelled += 1;
    if (ds === DOC_MISSING && d.docstatus !== DOC_MISSING) missing += 1;
    return ds === d.docstatus ? d : { ...d, docstatus: ds };
  });
  const submitted = docs.every((d) => d.docstatus === 1);
  const changed = submitted || docs.some((d, i) => d !== cur.createdDocs[i]);
  if (changed) await repo.upsertPending({ ...cur, createdDocs: docs, state: submitted ? 'submitted' : cur.state });
  return { submitted, cancelled, missing };
}

/** "Bring back": an ignored txn returns to the Inbox. No ERPNext call. Only if it is still ignored. */
export function bringBack(txnId: string, deps: { repo: Repo }): Promise<boolean> {
  return withTxnLock(txnId, async () => {
    const cur: PendingTxn | null = await deps.repo.getPending(txnId);
    if (!cur || cur.state !== 'ignored') return false;
    await deps.repo.upsertPending({ ...cur, state: 'new', error: null });
    return true;
  });
}
