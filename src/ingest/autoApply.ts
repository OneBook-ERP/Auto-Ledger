// Automatic answers (wave 3 K4): after each foreground cycle, new items matching a rule the user switched to
// automatic are answered with that rule's answer, as drafts only, through the same bulk engine (submitAnswer, the
// runner's per-txn lock, outbox and duplicate safety). Strictly one at a time, at most AUTO_LIMIT per run.
// Never retries an item that failed (it waits in the Inbox with its message), never raises the rule's largest
// confirmed amount, and never answers again an item the user took back with Undo. Never throws.
import { canAutoApply } from '../core/classify';
import { learnRule, nameKey, ruleChoice } from '../core/suggest';
import type { ActionChoice, PendingTxn, Rule } from '../core/types';
import type { Repo } from '../data/repo';
import { BULK_BUSY, BULK_SIGNED_OUT, applyToGroup } from '../inbox/bulk';
import type { InboxErp } from '../inbox/erp';
import { istToday } from '../inbox/format';
import { planChoice } from '../inbox/model';
import type { runPlan as RunPlan } from '../outbox/runner';
import { NEEDS_LOGIN_SINCE_KEY } from './drain';
import { COMPANY_SETTING, DUP_KEY_PREFIX } from './dupCheck';

/** At most this many automatic answers per cycle; the rest wait for the next one. */
export const AUTO_LIMIT = 25;

/** `auto_done:<txnId>` = {at}: answered automatically (Activity shows "Done automatically"). */
export const AUTO_DONE_PREFIX = 'auto_done:';
export const autoDoneKey = (id: string) => `${AUTO_DONE_PREFIX}${id}`;
/** `auto_failed:<txnId>` = the runner's message: not retried; the item waits in the Inbox until the user answers it. */
export const AUTO_FAILED_PREFIX = 'auto_failed:';
export const autoFailedKey = (id: string) => `${AUTO_FAILED_PREFIX}${id}`;
/** `auto_skip:<txnId>`: the user put an automatic answer back with Undo; never automatic again. */
export const AUTO_SKIP_PREFIX = 'auto_skip:';
/** How many automatic answers the Inbox banner announces ("3 payments were done automatically"); reset by Dismiss. */
export const AUTO_NEW_COUNT_KEY = 'auto_new_count';

/** Same key as DRAWINGS_KEY in src/state/useSetting (not imported here: that module is for screens). */
const DRAWINGS_SETTING = 'drawingsAccount';

export type AutoApplyDeps = { repo: Repo; erp: InboxErp; runPlan: typeof RunPlan; now: () => number };
export type AutoApplyResult = { done: string[]; failed: string[]; queued: string[] };

const idsOf = (rows: { key: string }[], prefix: string) => new Set(rows.map((r) => r.key.slice(prefix.length)));
const sameRule = (a: Rule, b: Rule) => JSON.stringify(a) === JSON.stringify(b);

/** Counts the automatic use of the rule without raising its largest confirmed amount. */
async function countUse(repo: Repo, txn: PendingTxn, choice: ActionChoice): Promise<void> {
  try {
    const rules = await repo.listRules();
    for (const r of learnRule(txn, choice, rules, { raiseMax: false })) {
      if (!rules.some((x) => sameRule(x, r))) await repo.saveRule(r);
    }
  } catch {
    // the draft exists; a missed count only changes "Used N times"
  }
}

async function bump(repo: Repo, n: number): Promise<void> {
  if (!n) return;
  try {
    await repo.setSetting(AUTO_NEW_COUNT_KEY, String((Number(await repo.getSetting(AUTO_NEW_COUNT_KEY)) || 0) + n));
  } catch {
    // the banner is best effort
  }
}

export async function runAutoApply(deps: AutoApplyDeps): Promise<AutoApplyResult> {
  const { repo } = deps;
  const out: AutoApplyResult = { done: [], failed: [], queued: [] };
  try {
    const [pending, queuedIds, failedRows, doneRows, skipRows] = await Promise.all([
      repo.listPending('new'), repo.listQueuedTxnIds(), repo.listSettings(AUTO_FAILED_PREFIX), repo.listSettings(AUTO_DONE_PREFIX),
      repo.listSettings(AUTO_SKIP_PREFIX),
    ]);
    const waiting = new Set(pending.map((t) => t.id));
    const queued = new Set(queuedIds);
    // A failure note lasts until the user acts: once the item is no longer waiting, the note goes.
    for (const id of idsOf(failedRows, AUTO_FAILED_PREFIX)) if (!waiting.has(id)) await repo.deleteSetting(autoFailedKey(id));
    const failed = idsOf(failedRows, AUTO_FAILED_PREFIX);
    const skip = idsOf(skipRows, AUTO_SKIP_PREFIX);
    // Answered automatically but waiting again (not just queued): the user took it back with Undo.
    for (const id of idsOf(doneRows, AUTO_DONE_PREFIX)) {
      if (waiting.has(id) && !queued.has(id)) {
        await repo.setSetting(`${AUTO_SKIP_PREFIX}${id}`, '1');
        await repo.deleteSetting(autoDoneKey(id));
        skip.add(id);
      }
    }
    const done = idsOf(doneRows, AUTO_DONE_PREFIX);

    if (await repo.getSetting(NEEDS_LOGIN_SINCE_KEY)) return out; // signed out: the items just wait
    const auto = (await repo.listRules()).filter((r) => r.auto === true);
    if (!auto.length) return out;
    const dups = idsOf(await repo.listSettings(DUP_KEY_PREFIX), DUP_KEY_PREFIX);
    const candidates = [...pending]
      .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1))
      .filter((t) => {
        if (queued.has(t.id) || failed.has(t.id) || skip.has(t.id) || done.has(t.id)) return false;
        const rule = auto.find((r) => r.matchKey === nameKey(t));
        return !!rule && canAutoApply(t, rule, dups.has(t.id));
      })
      .slice(0, AUTO_LIMIT);
    if (!candidates.length) return out;

    const [mappings, company, drawings] = await Promise.all([repo.listMappings(), repo.getSetting(COMPANY_SETTING), repo.getSetting(DRAWINGS_SETTING)]);
    const plan = planChoice({ mappings, company: company ?? '', drawingsAccount: drawings ?? '', today: istToday(deps.now()) });

    for (const t of candidates) {
      // Re-read before every item: a rule switched off, edited or deleted a moment ago stops the run at once,
      // and a warning that appeared meanwhile is respected.
      const rule = (await repo.listRules()).find((r) => r.matchKey === nameKey(t));
      const fresh = await repo.getPending(t.id);
      if (!rule || !fresh) continue;
      const dup = (await repo.getSetting(`${DUP_KEY_PREFIX}${t.id}`)) !== null;
      if (!canAutoApply(fresh, rule, dup)) continue;
      const choice = ruleChoice(rule) as ActionChoice;
      const r = await applyToGroup({ repo, erp: deps.erp, runPlan: deps.runPlan, plan }, [fresh], choice, { remember: false });
      if (r.done.length) {
        await repo.setSetting(autoDoneKey(t.id), JSON.stringify({ at: deps.now() }));
        out.done.push(t.id);
        await countUse(repo, (await repo.getPending(t.id)) ?? fresh, choice);
        continue;
      }
      if (r.queued.length) {
        // No connection: the answer is saved and sent by the drain; nothing more is tried this run.
        await repo.setSetting(autoDoneKey(t.id), JSON.stringify({ at: deps.now() }));
        out.queued.push(t.id);
        break;
      }
      const f = r.failed[0];
      if (!f) continue; // skipped: answered meanwhile
      if (f.message === BULK_SIGNED_OUT) break; // the item waits for the next sign-in; not parked
      if (f.message === BULK_BUSY) continue; // the user is answering it right now
      await repo.setSetting(autoFailedKey(t.id), f.message);
      out.failed.push(t.id);
    }
  } catch {
    // local storage failing: what was done stays done; the next cycle tries again
  }
  await bump(repo, out.done.length);
  return out;
}
