// Answering a group of similar items with one answer (wave 3 K). Each item goes through submitAnswer, exactly as a
// single answer does (same runner, per-txn lock, outbox and duplicate safety). One item at a time by default.
// A failure never stops the others and nothing already done is rolled back. Before each item the stored row is
// re-read: an item that is already answered, or whose answer is already waiting to be sent, is skipped, so a
// retry of the whole group never creates a second document.
import { AUTO_ACTIONS } from '../core/classify';
import type { ActionChoice, ActionPlan, PendingTxn } from '../core/types';
import { UNKNOWN_FAILURE, planErrorMessage, type Outcome } from './outcome';
import { submitAnswer, type SubmitDeps } from './submit';

/** SubmitDeps plus the planner for one item (the caller binds company, account mapping and today). May throw PlanError. */
export type BulkDeps = SubmitDeps & { plan: (txn: PendingTxn, choice: ActionChoice) => ActionPlan };

export type BulkResult = {
  /** A draft was created (or the item ignored). */
  done: string[];
  /** Needs the user's attention; the item stays in the Inbox. */
  failed: { id: string; message: string }[];
  /** No connection: the answer is saved and will be sent when back online (as for a single answer). */
  queued: string[];
  /** Already answered, already waiting to be sent, or no longer in the Inbox: nothing was done. */
  skipped: string[];
};

export const BULK_ONLY_ONE_BY_ONE = 'This answer has to be given one payment at a time. Open each payment to answer it.';
export const BULK_SIGNED_OUT = 'You are signed out of ERPNext. Sign in again; this answer is saved and will be sent then.';
export const BULK_BUSY = 'This payment is already being sent. Check it again in a moment.';

type ItemResult = { kind: 'done' } | { kind: 'queued' } | { kind: 'skipped' } | { kind: 'failed'; message: string };

async function applyOne(deps: BulkDeps, id: string, choice: ActionChoice, remember: boolean): Promise<ItemResult> {
  let txn: PendingTxn | null;
  try {
    txn = await deps.repo.getPending(id);
    if (!txn) return { kind: 'skipped' };
    if (txn.state !== 'new') return { kind: 'skipped' };
    if ((await deps.repo.listOutbox(id)).some((o) => o.status === 'pending')) return { kind: 'skipped' };
  } catch {
    return { kind: 'failed', message: UNKNOWN_FAILURE };
  }
  let plan: ActionPlan;
  try {
    plan = deps.plan(txn, choice);
  } catch (e) {
    return { kind: 'failed', message: planErrorMessage(e) };
  }
  let o: Outcome;
  try {
    o = await submitAnswer(deps, { txn, plan, choice, remember });
  } catch {
    return { kind: 'failed', message: UNKNOWN_FAILURE };
  }
  switch (o.kind) {
    case 'created': return { kind: 'done' };
    case 'offline': return { kind: 'queued' };
    case 'gone': return { kind: 'skipped' };
    case 'login': return { kind: 'failed', message: BULK_SIGNED_OUT };
    case 'busy': return { kind: 'failed', message: BULK_BUSY };
    case 'error': return { kind: 'failed', message: o.message || UNKNOWN_FAILURE };
    default: return { kind: 'failed', message: UNKNOWN_FAILURE };
  }
}

/**
 * Gives `choice` to every item, one at a time (`concurrency` 1 by default, so correlation and outbox locks stay
 * simple). Only expense, supplier payment, other income, personal and ignore may be given in bulk; any other answer
 * fails every item with a plain message and nothing runs. `remember` (default true) learns the rule per success.
 * Results list ids in input order; a repeated id runs once.
 */
export async function applyToGroup(
  deps: BulkDeps,
  items: PendingTxn[],
  choice: ActionChoice,
  opts: { concurrency?: number; remember?: boolean } = {},
): Promise<BulkResult> {
  const ids = [...new Set(items.map((t) => t.id))];
  const out: BulkResult = { done: [], failed: [], queued: [], skipped: [] };
  if (!AUTO_ACTIONS.has(choice.type)) {
    out.failed = ids.map((id) => ({ id, message: BULK_ONLY_ONE_BY_ONE }));
    return out;
  }
  const remember = opts.remember !== false;
  const width = Math.max(1, Math.min(ids.length, Math.floor(opts.concurrency ?? 1) || 1));
  const results: ItemResult[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      results[i] = await applyOne(deps, ids[i], choice, remember);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  ids.forEach((id, i) => {
    const r = results[i];
    if (r.kind === 'failed') out.failed.push({ id, message: r.message });
    else out[r.kind].push(id);
  });
  return out;
}
