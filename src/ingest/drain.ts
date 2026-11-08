// Outbox drainer (Task 13 contract): replays queued plans in order through runPlan, WITHOUT userAction, so
// it never enqueues, re-opens or revives anything; only the UI passes {userAction: true}.
//
// Stop rules: 'created' or a non-retryable 'failed' -> next item; a retryable 'failed' -> stop
// ('retry_later'); 'needs_login' -> see below. At most DRAIN_LIMIT runs per call. Nothing here logs.
//
// needs_login: erp.checkSession() is asked on EVERY needs_login result. Session invalid (false or throws):
// the credentials are the problem, so the per-item counter `needs_login_count:<itemId>` is reset to 0,
// `needs_login_since` is set (first time only) and the drain stops. Session valid: the server refuses this
// document (a role problem, a permanent 403 that would block the queue forever), so the counter is
// incremented and `needs_login_since` cleared; at NEEDS_LOGIN_PARK_AFTER the item is parked through
// runner.parkForPermission (under the runner's per-txn lock; it parks only if the item is still pending and
// the txn still 'new', so a decision the user made meanwhile is never overwritten) and draining continues.
// Any other result resets the item's counter and clears `needs_login_since` ('' = no login needed).
//
// Known limitation: a retryable failure of the head item stops the drain ('retry_later') and so blocks the
// items behind it until it succeeds or fails for good; there is no attempts cap in phase 1.
import type { Repo } from '../data/repo';
import { PERMISSION_DENIED_MESSAGE, parkForPermission, runPlan, type ErpOps } from '../outbox/runner';

export const DRAIN_LIMIT = 20;
export const NEEDS_LOGIN_PARK_AFTER = 3;
export const NEEDS_LOGIN_SINCE_KEY = 'needs_login_since';
export const needsLoginCountKey = (itemId: string) => `needs_login_count:${itemId}`;
export { PERMISSION_DENIED_MESSAGE } from '../outbox/runner';

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

async function resetCounter(repo: Repo, key: string): Promise<void> {
  const cur = await repo.getSetting(key);
  if (cur !== null && cur !== '0') await repo.setSetting(key, '0');
}

async function clearNeedsLogin(repo: Repo): Promise<void> {
  if (await repo.getSetting(NEEDS_LOGIN_SINCE_KEY)) await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, '');
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
      if (!(await sessionValid(erp))) {
        if ((await repo.getSetting(countKey)) !== '0') await repo.setSetting(countKey, '0');
        if (!(await repo.getSetting(NEEDS_LOGIN_SINCE_KEY))) await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, String(now()));
        return { ran, stoppedBecause: 'needs_login' };
      }
      await clearNeedsLogin(repo);
      const count = (parseInt((await repo.getSetting(countKey)) ?? '0', 10) || 0) + 1;
      if (count >= NEEDS_LOGIN_PARK_AFTER) {
        await parkForPermission(item.txnId, item.id, { repo }); // 'skipped' when the user decided meanwhile
        await repo.setSetting(countKey, '0');
        continue;
      }
      await repo.setSetting(countKey, String(count));
      return { ran, stoppedBecause: 'needs_login' };
    }

    await resetCounter(repo, countKey);
    await clearNeedsLogin(repo);
    if (res.status === 'created') continue;
    if (res.retryable) return { ran, stoppedBecause: 'retry_later' };
  }
  return { ran, stoppedBecause: 'limit' };
}
