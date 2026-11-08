// Outbox drainer (Task 13 contract): replays queued plans in order through runPlan, WITHOUT userAction, so
// it never enqueues, re-opens or revives anything; only the UI passes {userAction: true}.
//
// Stop rules: 'created' or a non-retryable 'failed' -> next item; a retryable 'failed' -> stop
// ('retry_later'); 'needs_login' -> stop and persist `needs_login_since`. A permanent 403 (a role problem,
// not a credentials problem) would otherwise block the queue forever, so consecutive needs_login results for
// the same item are counted (`needs_login_count:<itemId>`); from the 3rd on, if erp.checkSession() says the
// session itself is still valid, the item is marked failed and its txn goes back to the Inbox with a plain
// message, and draining continues. At most DRAIN_LIMIT runs per call. Nothing here logs.
import type { Repo } from '../data/repo';
import { runPlan, type ErpOps } from '../outbox/runner';

export const DRAIN_LIMIT = 20;
export const NEEDS_LOGIN_PARK_AFTER = 3;
export const NEEDS_LOGIN_SINCE_KEY = 'needs_login_since';
export const needsLoginCountKey = (itemId: string) => `needs_login_count:${itemId}`;
export const PERMISSION_DENIED_MESSAGE =
  'Your ERPNext user is not allowed to create this document; ask your administrator for access, then try again';

export interface DrainErp extends ErpOps {
  /** Calls a cheap authenticated endpoint (frappe.auth.get_logged_user); true when the credentials still work. */
  checkSession(): Promise<boolean>;
}

export type DrainResult = { ran: number; stoppedBecause: 'empty' | 'needs_login' | 'retry_later' | 'limit' };

export type DrainDeps = { repo: Repo; erp: DrainErp; now: () => number };

const inFlight = new WeakMap<Repo, Promise<DrainResult>>();

/** Single-flight per Repo: a call while a drain is running joins that drain. */
export function drainOutbox(deps: DrainDeps): Promise<DrainResult> {
  const running = inFlight.get(deps.repo);
  if (running) return running;
  const p = drain(deps).finally(() => inFlight.delete(deps.repo));
  inFlight.set(deps.repo, p);
  return p;
}

async function sessionValid(erp: DrainErp): Promise<boolean> {
  try {
    return (await erp.checkSession()) === true;
  } catch {
    return false;
  }
}

async function drain({ repo, erp, now }: DrainDeps): Promise<DrainResult> {
  let ran = 0;
  while (ran < DRAIN_LIMIT) {
    const item = await repo.nextOutbox();
    if (!item) return { ran, stoppedBecause: 'empty' };
    const countKey = needsLoginCountKey(item.id);

    let res: Awaited<ReturnType<typeof runPlan>>;
    try {
      res = await runPlan(item.txnId, item.plan, { repo, erp });
    } catch (e) {
      ran++;
      // runPlan throws only for a missing txn or a local storage failure.
      if (!(await repo.getPending(item.txnId))) {
        await repo.markOutbox(item.id, { status: 'failed' });
        continue;
      }
      throw e;
    }
    ran++;

    if (res.status === 'needs_login') {
      const count = (parseInt((await repo.getSetting(countKey)) ?? '0', 10) || 0) + 1;
      await repo.setSetting(countKey, String(count));
      if (count >= NEEDS_LOGIN_PARK_AFTER && (await sessionValid(erp))) {
        await repo.markOutbox(item.id, { status: 'failed' });
        const t = await repo.getPending(item.txnId);
        if (t) await repo.upsertPending({ ...t, state: 'new', error: PERMISSION_DENIED_MESSAGE });
        await repo.setSetting(countKey, '0');
        continue;
      }
      if (!(await repo.getSetting(NEEDS_LOGIN_SINCE_KEY))) await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, String(now()));
      return { ran, stoppedBecause: 'needs_login' };
    }

    if ((await repo.getSetting(countKey)) !== null) await repo.setSetting(countKey, '0');
    if (res.status === 'created') {
      if (await repo.getSetting(NEEDS_LOGIN_SINCE_KEY)) await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, '');
      continue;
    }
    if (res.retryable) return { ran, stoppedBecause: 'retry_later' };
  }
  return { ran, stoppedBecause: 'limit' };
}
