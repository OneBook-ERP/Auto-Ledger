// Automatic answers (wave 3 K4): after each foreground cycle, new items matching a rule the user switched to
// automatic are answered with that rule's answer, as drafts only, through the same bulk engine (submitAnswer, the
// runner's per-txn lock, outbox and duplicate safety). Strictly one at a time, at most AUTO_LIMIT per run.
// Never retries an item that failed (it waits in the Inbox with its message), never raises the rule's largest
// confirmed amount, and never answers again an item the user took back with Undo. Never throws.
//
// Look-alikes (final review I1): an item is NEVER answered automatically when ANOTHER stored item (any state:
// waiting, answered by the app or by the user, ignored) has the same pattern key (nameKey: direction + normalised
// name), the same currency and amount (exact paise), and a date at most SIMILAR_DAYS (3) days away (an unreadable
// date on either side counts as near). The rule is symmetric, so two identical new items both wait, and an item whose
// look-alike the app answered yesterday waits too. Such an item gets `auto_held:<id>` = the look-alike's id and the
// Inbox shows "Looks like another payment: check before answering". The bank sending two SMS for ONE payment is
// already merged into one item before this point, so a look-alike is either a real second payment or a duplicate the
// user must judge; the app never decides that alone.
import { canAutoApply } from '../core/classify';
import { SIMILAR_DAYS, dayNumber } from '../core/similar';
import { learnRule, nameKey, ruleChoice } from '../core/suggest';
import type { ActionChoice, PendingTxn, Rule } from '../core/types';
import type { Repo } from '../data/repo';
import { BULK_BUSY, BULK_SIGNED_OUT, applyToGroup } from '../inbox/bulk';
import { actionsFor } from '../inbox/actions';
import type { InboxErp } from '../inbox/erp';
import { istToday } from '../inbox/format';
import { planChoice, ruleHasAnswer } from '../inbox/model';
import type { runPlan as RunPlan } from '../outbox/runner';
import { NEEDS_LOGIN_SINCE_KEY } from './drain';
import { CHECKED_FROM_KEY, COMPANY_SETTING, DUP_KEY_PREFIX } from './dupCheck';

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
/** `auto_held:<txnId>` = the look-alike's id: not answered automatically (see the header); cleared once it stops waiting. */
export const AUTO_HELD_PREFIX = 'auto_held:';
export const autoHeldKey = (id: string) => `${AUTO_HELD_PREFIX}${id}`;
/**
 * `auto_since:<matchKey>` = ms time the user made the pattern automatic. Only items that arrived after it are ever
 * answered automatically: the backlog, and items the user left unticked in a bulk answer, always wait for the user.
 */
export const AUTO_SINCE_PREFIX = 'auto_since:';
export const autoSinceKey = (matchKey: string) => `${AUTO_SINCE_PREFIX}${matchKey}`;
/** How many automatic answers the Inbox banner announces ("3 payments were done automatically"); reset by Dismiss. */
export const AUTO_NEW_COUNT_KEY = 'auto_new_count';

/** Same key as DRAWINGS_KEY in src/state/useSetting (not imported here: that module is for screens). */
const DRAWINGS_SETTING = 'drawingsAccount';

export type AutoApplyDeps = { repo: Repo; erp: InboxErp; runPlan: typeof RunPlan; now: () => number };
export type AutoApplyResult = { done: string[]; failed: string[]; queued: string[] };

/** Saves `rule` switched on or off. On records "from now on"; off forgets it, so switching on again restarts the clock. */
export async function switchAutomatic(repo: Repo, rule: Rule, on: boolean, now: number): Promise<void> {
  if (on) await repo.setSetting(autoSinceKey(rule.matchKey), String(now));
  else await repo.deleteSetting(autoSinceKey(rule.matchKey));
  await repo.saveRule({ ...rule, auto: on });
}

/** Deletes the rule of one pattern and its automatic start time. Drafts already created are not touched. */
export async function forgetRule(repo: Repo, matchKey: string): Promise<void> {
  await repo.deleteSetting(autoSinceKey(matchKey));
  await repo.deleteRule(matchKey);
}

/** The JSON of `auto_done:<id>`: when, and which documents the app created (the chip is shown only while they are the item's). */
export type AutoDoneMark = { at: number; docs: string[]; queued?: boolean };

export function parseAutoDone(v: string | null | undefined): AutoDoneMark | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as Partial<AutoDoneMark> | null;
    if (!o || typeof o.at !== 'number') return null;
    const docs = Array.isArray(o.docs) ? o.docs.filter((d): d is string => typeof d === 'string') : [];
    return o.queued === true ? { at: o.at, docs, queued: true } : { at: o.at, docs };
  } catch {
    return null;
  }
}

const idsOf = (rows: { key: string }[], prefix: string) => new Set(rows.map((r) => r.key.slice(prefix.length)));

/** For each item, another stored item that looks the same (see the header), or none. One pass over all items. */
function lookAlikes(all: PendingTxn[]): (t: PendingTxn) => PendingTxn | null {
  const buckets = new Map<string, { t: PendingTxn; day: number | null }[]>();
  const keyOf = (t: PendingTxn) => {
    const name = nameKey(t);
    return name ? `${name}\u0000${t.currency}\u0000${t.amountMinor}` : null;
  };
  for (const t of all) {
    const k = keyOf(t);
    if (!k) continue;
    const b = buckets.get(k);
    const v = { t, day: dayNumber(t.occurredOn) };
    if (b) b.push(v);
    else buckets.set(k, [v]);
  }
  return (t) => {
    const k = keyOf(t);
    const day = dayNumber(t.occurredOn);
    for (const o of (k && buckets.get(k)) || []) {
      if (o.t.id === t.id) continue;
      if (day === null || o.day === null || Math.abs(day - o.day) <= SIMILAR_DAYS) return o.t;
    }
    return null;
  };
}
const sameRule = (a: Rule, b: Rule) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Counts the automatic use of the rule without raising its largest confirmed amount, and only while the stored rule
 * still gives this answer (a rule deleted or changed meanwhile is left exactly as the user left it).
 */
async function countUse(repo: Repo, txn: PendingTxn, choice: ActionChoice): Promise<void> {
  try {
    const rules = await repo.listRules();
    const key = nameKey(txn);
    const stored = rules.find((r) => r.matchKey === key);
    if (!stored || !ruleHasAnswer(stored, choice)) return;
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
    const [all, queuedIds, failedRows, doneRows, skipRows, heldRows] = await Promise.all([
      repo.listPending(), repo.listQueuedTxnIds(), repo.listSettings(AUTO_FAILED_PREFIX), repo.listSettings(AUTO_DONE_PREFIX),
      repo.listSettings(AUTO_SKIP_PREFIX), repo.listSettings(AUTO_HELD_PREFIX),
    ]);
    const pending = all.filter((t) => t.state === 'new');
    const waiting = new Set(pending.map((t) => t.id));
    const queued = new Set(queuedIds);
    // A failure note lasts until the user acts: once the item is no longer waiting, the note goes.
    for (const id of idsOf(failedRows, AUTO_FAILED_PREFIX)) if (!waiting.has(id)) await repo.deleteSetting(autoFailedKey(id));
    const failed = idsOf(failedRows, AUTO_FAILED_PREFIX);
    const held = new Map(heldRows.map((r) => [r.key.slice(AUTO_HELD_PREFIX.length), r.value]));
    for (const id of held.keys()) if (!waiting.has(id)) await repo.deleteSetting(autoHeldKey(id));
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
    const since = new Map<string, number>();
    for (const s of await repo.listSettings(AUTO_SINCE_PREFIX)) since.set(s.key.slice(AUTO_SINCE_PREFIX.length), Number(s.value) || 0);
    // Items dated before what the duplicate check could read were never checked: they wait for the user.
    const checkedFrom = await repo.getSetting(CHECKED_FROM_KEY);
    const fits = (t: PendingTxn, rule: Rule) => {
      const from = since.get(rule.matchKey) ?? 0;
      return from > 0 && t.receivedAt > from
        && (!checkedFrom || t.occurredOn >= checkedFrom)
        && actionsFor(t.direction, t.accountType).some((a) => a.type === rule.action);
    };
    const lookAlike = lookAlikes(all);
    const hold: [PendingTxn, PendingTxn][] = [];
    const candidates = [...pending]
      .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1))
      .filter((t) => {
        if (queued.has(t.id) || failed.has(t.id) || skip.has(t.id) || done.has(t.id)) return false;
        const rule = auto.find((r) => r.matchKey === nameKey(t));
        if (!rule || !fits(t, rule) || !canAutoApply(t, rule, dups.has(t.id))) return false;
        const other = lookAlike(t);
        if (other) hold.push([t, other]);
        return !other;
      });
    // Look-alikes wait for the user with a note naming the other item (written once).
    for (const [t, other] of hold) if (held.get(t.id) !== other.id) await repo.setSetting(autoHeldKey(t.id), other.id);
    if (!candidates.length) return out;

    const [mappings, company, drawings] = await Promise.all([repo.listMappings(), repo.getSetting(COMPANY_SETTING), repo.getSetting(DRAWINGS_SETTING)]);
    const plan = planChoice({ mappings, company: company ?? '', drawingsAccount: drawings ?? '', today: istToday(deps.now()) });

    let tried = 0;
    for (const t of candidates) {
      if (tried >= AUTO_LIMIT) break;
      // Signed out meanwhile (another request saw the session end): the rest of the batch waits for sign-in.
      if (await repo.getSetting(NEEDS_LOGIN_SINCE_KEY)) break;
      // Re-read before every item: a rule switched off, edited or deleted a moment ago stops the run at once,
      // and a warning that appeared meanwhile is respected.
      const rule = (await repo.listRules()).find((r) => r.matchKey === nameKey(t));
      const fresh = await repo.getPending(t.id);
      if (!rule || !fresh) continue;
      const startedAt = Number(await repo.getSetting(autoSinceKey(rule.matchKey))) || 0;
      if (startedAt <= 0 || fresh.receivedAt <= startedAt) continue;
      const dup = (await repo.getSetting(`${DUP_KEY_PREFIX}${t.id}`)) !== null;
      if (!canAutoApply(fresh, rule, dup) || !fits(fresh, rule)) continue;
      // Ever answered before (Undo, Bring back, a failed answer of the user's own): always the user's call.
      if (fresh.createdDocs.length || (await repo.listOutbox(t.id)).length) {
        await repo.setSetting(`${AUTO_SKIP_PREFIX}${t.id}`, '1');
        continue;
      }
      tried++;
      const choice = ruleChoice(rule) as ActionChoice;
      const r = await applyToGroup({ repo, erp: deps.erp, runPlan: deps.runPlan, plan }, [fresh], choice, { remember: false });
      if (r.done.length) {
        const after = (await repo.getPending(t.id)) ?? fresh;
        await repo.setSetting(autoDoneKey(t.id), JSON.stringify({ at: deps.now(), docs: after.createdDocs.map((d) => d.name) } satisfies AutoDoneMark));
        out.done.push(t.id);
        await countUse(repo, after, choice);
        continue;
      }
      if (r.queued.length) {
        // No connection: the answer is saved and sent by the drain; nothing more is tried this run.
        await repo.setSetting(autoDoneKey(t.id), JSON.stringify({ at: deps.now(), docs: [], queued: true } satisfies AutoDoneMark));
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
