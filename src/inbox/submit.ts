// Sending one answer: runPlan on the UI path (ALWAYS userAction: true), then learning the rule on success.
// One submit per txn at a time: a second tap, or another screen, gets {kind: 'busy'} and nothing runs.
import { learnRule } from '../core/suggest';
import type { ActionChoice, ActionPlan, PendingTxn, Rule } from '../core/types';
import type { Repo } from '../data/repo';
import { PERMISSION_DENIED_MESSAGE, type runPlan as RunPlan } from '../outbox/runner';
import type { InboxErp } from './erp';
import { outcomeOf, type Outcome } from './outcome';

const running = new Set<string>();
export const isSubmitting = (txnId: string) => running.has(txnId);

export type SubmitDeps = { repo: Repo; erp: InboxErp; runPlan: typeof RunPlan };

const sameRule = (a: Rule, b: Rule) => JSON.stringify(a) === JSON.stringify(b);

async function remember(repo: Repo, txn: PendingTxn, choice: ActionChoice): Promise<void> {
  const rules = await repo.listRules();
  for (const r of learnRule(txn, choice, rules)) {
    if (!rules.some((x) => sameRule(x, r))) await repo.saveRule(r);
  }
}

export async function submitAnswer(
  deps: SubmitDeps,
  a: { txn: PendingTxn; plan: ActionPlan; choice: ActionChoice; remember: boolean },
): Promise<Outcome> {
  const { repo, erp } = deps;
  const id = a.txn.id;
  if (running.has(id)) return { kind: 'busy' };
  running.add(id);
  try {
    const before = (await repo.getPending(id))?.error ?? null;
    const r = await deps.runPlan(id, a.plan, { repo, erp }, { userAction: true });
    if (r.status === 'created') {
      if (a.remember) {
        try {
          await remember(repo, (await repo.getPending(id)) ?? a.txn, a.choice);
        } catch {
          // The entry exists; a rule that could not be saved only means no suggestion next time.
        }
      }
      return outcomeOf(r, null, a.plan);
    }
    if (r.status === 'needs_login') {
      // A refusal with working credentials is a permission problem, not an expired login.
      let valid = false;
      try {
        valid = await erp.checkSession();
      } catch {
        valid = false;
      }
      if (valid) return { kind: 'error', message: `${PERMISSION_DENIED_MESSAGE}.`, missingFields: [], doctype: null, closedPeriod: false };
      return { kind: 'login' };
    }
    const after = (await repo.getPending(id))?.error ?? null;
    return outcomeOf(r, after && after !== before ? after : null, a.plan);
  } finally {
    running.delete(id);
  }
}
