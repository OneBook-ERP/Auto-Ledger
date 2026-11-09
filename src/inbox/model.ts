// Inbox view-model: rows, sections, header and notices from repo data. Pure; the clock is passed in.
import { AUTO_ACTIONS, groupSimilar } from '../core/classify';
import { learnRule, nameKey, suggest } from '../core/suggest';
import type { AccountMapping, ActionChoice, ActionPlan, PartyRef, PendingTxn, Rule } from '../core/types';
import { resolveMapping } from '../ingest/pipeline';
import { formatInr } from '../ui/format';
import { actionsFor, actionLabel, type ActionItem } from './actions';
import type { BulkResult } from './bulk';
import { planFor, type FlowDraft } from './flow';
import { amountA11y, accountLabel, istToday, kindLabel, plainAmount, relativeAgo, shortAccount, signedAmount, titleOf, whenLabel } from './format';
import { filterPending, type InboxFilter } from './inboxFilter';
import { chipFor, type ChipView } from './suggestions';

/** Written by the provider after a fully successful cycle (Task 19). */
export { LAST_SYNCED_KEY } from '../home/viewModel';

export type InboxInputs = {
  /** Txns in state 'new'. */
  pending: PendingTxn[];
  mappings: AccountMapping[];
  rules: Rule[];
  /** Txns in state 'created' (drafts waiting for the accountant). */
  createdCount: number;
  unreadCount: number;
  /** last-4 values of `unrecognised_account:<last4>` flags. */
  unknownAccounts: string[];
  lastSyncedAt: number | null;
  now: number;
  /** Txns whose answer is queued in the outbox (sent when back online). */
  queuedIds: string[];
  /** Search, period and filters; rows, count and suggestions only cover what matches. */
  filter?: InboxFilter;
  /** Remembers suggestions between rebuilds (keep one per screen). Without it nothing is remembered. */
  chips?: ChipCache;
  /** Txn id -> why the app could not answer it automatically (it waits for the user). */
  autoFailed?: Record<string, string>;
  /** Txn id -> the look-alike's id: not answered automatically because it looks like another payment. */
  autoHeld?: Record<string, string>;
  /** Payments answered automatically since the user last dismissed the notice. */
  autoDoneCount?: number;
};

/** Suggestion chips remembered by txn id and by the rules they were computed with. */
export type ChipCache = {
  get(t: PendingTxn, rules: Rule[], version: string): ChipView;
  /** Forget every txn not in `ids` (answered or removed), so the cache never outgrows the Inbox. */
  prune(ids: ReadonlySet<string>): void;
  readonly size: number;
};

export function createChipCache(): ChipCache {
  const m = new Map<string, { version: string; chip: ChipView }>();
  return {
    get(t, rules, version) {
      const hit = m.get(t.id);
      if (hit && hit.version === version) return hit.chip;
      const chip: ChipView = chipFor(t, suggest(t, rules, [], []));
      // A merchant (card spend) is not a person: ask what it was, not who it is.
      if (chip.text === 'Who is this?' && t.merchant && !t.counterparty) chip.text = 'What was this?';
      m.set(t.id, { version, chip });
      return chip;
    },
    prune(ids) {
      for (const k of m.keys()) if (!ids.has(k)) m.delete(k);
    },
    get size() {
      return m.size;
    },
  };
}

/** Changes whenever a rule is added, edited or used. */
export const rulesVersion = (rules: Rule[]) => rules.map((r) => `${r.matchKey}|${r.action}|${r.account ?? ''}|${r.party?.name ?? ''}|${r.hits}|${r.lastUsed}`).join(';');

const QUEUED_CHIP: ChipView = { text: 'Answer saved, waiting to send', tone: 'plain' };
const AUTO_FAILED_CHIP: ChipView = { text: 'Not done automatically. Open it to answer.', tone: 'warn' };
const AUTO_HELD_CHIP: ChipView = { text: 'Looks like another payment: check before answering', tone: 'warn' };

export type InboxItem = { type: 'header'; key: string; title: string } | { type: 'row'; key: string; row: InboxRow };

/** The first `rowLimit` rows, each section's heading in front of its first shown row. */
export function pageItems(sections: InboxModel['sections'], rowLimit: number): InboxItem[] {
  const out: InboxItem[] = [];
  let left = rowLimit;
  for (const s of sections) {
    if (left <= 0) break;
    out.push({ type: 'header', key: `h:${s.title}`, title: s.title });
    for (const r of s.rows.slice(0, left)) out.push({ type: 'row', key: r.id, row: r });
    left -= s.rows.length;
  }
  return out;
}

export type InboxRow = {
  id: string; title: string; subtitle: string; amountText: string; amountA11y: string; direction: 'in' | 'out';
  /** Leading icon: how the money moved (card, UPI, bank). Direction is shown by the amount, not by this. */
  kindIcon: 'card' | 'upi' | 'bank';
};

/** Card spends show a card, a UPI address a phone, everything else a bank. */
export function kindIconOf(t: Pick<PendingTxn, 'kind' | 'counterparty'>): InboxRow['kindIcon'] {
  if (t.kind === 'card_spend' || t.kind === 'card_si_paid') return 'card';
  if (t.counterparty?.includes('@')) return 'upi';
  return 'bank';
}
export type InboxModel = {
  /** Nothing is waiting at all (not the same as nothing matching the search or filters). */
  empty: boolean;
  /** Something is waiting but the search or filters hide all of it. */
  noMatch: boolean;
  /** Last four digits of every account seen in the waiting items (for the filter sheet). */
  accounts: string[];
  countLabel: string;
  trustLine: string;
  rows: InboxRow[];
  /** The chip of one row, computed when asked (for rows on screen) and remembered. */
  chipOf: (id: string) => ChipView;
  sections: { title: string; rows: InboxRow[] }[];
  unreadText: string | null;
  unknownAccounts: { last4: string; text: string }[];
  /** ONE compact notice for all unset accounts, or null. */
  accountsNotice: { text: string; last4s: string[] } | null;
  /** Similar waiting payments (2 or more with the same name), largest group first; they can be answered together. */
  groups: GroupCard[];
  /** Waiting items the app could not answer automatically, with the plain reason. */
  autoFailed: { id: string; text: string }[];
  /** "3 payments were done automatically. See Activity.", or null. */
  autoDoneText: string | null;
};

export type GroupCard = {
  key: string;
  count: number;
  /** "40 payments to Facebook, ₹1,24,000.00 in total". */
  title: string;
  /** "Suggested: Expense, Advertising" or "Choose what these were". */
  answer: string;
};

/** Newest first (receivedAt, then id for a stable order). */
export const newestFirst = (xs: PendingTxn[]) => [...xs].sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1));

export function buildInboxModel(i: InboxInputs): InboxModel {
  const today = istToday(i.now);
  const yesterday = istToday(i.now - 86_400_000);
  const queued = new Set(i.queuedIds);
  const TITLES = ['Today', 'Yesterday', 'Earlier'] as const;
  const bucket = (t: PendingTxn) => (t.occurredOn === today ? 0 : t.occurredOn === yesterday ? 1 : 2);
  // Newest first within a day group; every row of a group sits together (no "Today / Earlier / Today").
  const groups: PendingTxn[][] = [[], [], []];
  const shown = i.filter ? filterPending(i.pending, i.filter, today) : i.pending;
  for (const t of newestFirst(shown)) groups[bucket(t)].push(t);
  const toRow = (t: PendingTxn): InboxRow => {
    const mapping = resolveMapping(i.mappings, t);
    return {
      id: t.id,
      title: titleOf(t),
      subtitle: [kindLabel(t.kind), accountLabel(t, mapping), whenLabel(t, today)].join(' · '),
      amountText: signedAmount(t),
      amountA11y: amountA11y(t),
      direction: t.direction,
      kindIcon: kindIconOf(t),
    };
  };
  const chips = i.chips ?? createChipCache();
  const version = rulesVersion(i.rules);
  const byId = new Map(i.pending.map((t) => [t.id, t]));
  const autoFailed = i.autoFailed ?? {};
  const chipOf = (id: string): ChipView => {
    if (queued.has(id)) return QUEUED_CHIP;
    if (autoFailed[id] !== undefined) return AUTO_FAILED_CHIP;
    if (i.autoHeld?.[id] !== undefined) return AUTO_HELD_CHIP;
    const t = byId.get(id);
    return t ? chips.get(t, i.rules, version) : { text: 'Who is this?', tone: 'plain' };
  };
  const sections = groups.map((g, k) => ({ title: TITLES[k] as string, rows: g.map(toRow) })).filter((s) => s.rows.length > 0);
  const rows = sections.flatMap((s) => s.rows);
  const n = rows.length;
  const drafts = `${i.createdCount} draft${i.createdCount === 1 ? '' : 's'} waiting for your accountant`;
  const synced = i.lastSyncedAt === null ? 'Not synced yet' : `Synced ${relativeAgo(i.now, i.lastSyncedAt)}`;
  return {
    empty: i.pending.length === 0,
    noMatch: i.pending.length > 0 && n === 0,
    accounts: [...new Set(i.pending.map((t) => t.accountLast4).filter((x): x is string => !!x))].sort(),
    countLabel: n === 0 ? 'Nothing to answer' : `${n} to answer`,
    trustLine: `${synced} · ${drafts}`,
    rows,
    chipOf,
    sections,
    unreadText: i.unreadCount > 0 ? `${i.unreadCount} message${i.unreadCount === 1 ? '' : 's'} could not be read` : null,
    accountsNotice: i.unknownAccounts.length === 0 ? null : {
      last4s: i.unknownAccounts,
      text: `${i.unknownAccounts.length} account${i.unknownAccounts.length === 1 ? ' is' : 's are'} not set up: ${i.unknownAccounts.join(', ')}`,
    },
    unknownAccounts: i.unknownAccounts.map((l) => ({ last4: l, text: `Unrecognised account ending ${l}: add it in Settings` })),
    groups: groupCards(shown.filter((t) => !queued.has(t.id)), i.rules),
    autoDoneText: i.autoDoneCount && i.autoDoneCount > 0
      ? `${i.autoDoneCount === 1 ? '1 payment was' : `${i.autoDoneCount} payments were`} done automatically. See Activity.`
      : null,
    autoFailed: newestFirst(i.pending.filter((t) => autoFailed[t.id] !== undefined && !queued.has(t.id))).map((t) => ({
      id: t.id, text: `${titleOf(t)}, ${plainAmount(t)}: ${plainFailure(autoFailed[t.id])}`,
    })),
  };
}

// ---------- answering similar payments together (wave 3 K) ----------

/** The answers that fit EVERY item and may be given in bulk (expense, supplier payment, other income, personal, ignore). */
export function bulkActions(items: Pick<PendingTxn, 'direction' | 'accountType'>[]): ActionItem[] {
  if (!items.length) return [];
  const lists = items.map((t) => actionsFor(t.direction, t.accountType));
  return lists[0].filter((a) => AUTO_ACTIONS.has(a.type) && lists.every((l) => l.some((x) => x.type === a.type)));
}

/** "Expense, Advertising", "Expense, Advertising, for Meta", "Supplier payment, Meta Platforms", "Ignore this message". */
export function answerText(c: Partial<ActionChoice>, direction: 'in' | 'out', kind: 'bank' | 'card'): string {
  const label = c.type ? actionLabel(c.type, direction, kind) : 'Not chosen yet';
  const r = c as { expenseAccount?: string; incomeAccount?: string; party?: PartyRef };
  const account = r.expenseAccount ?? r.incomeAccount;
  if (account) return r.party ? `${label}, ${shortAccount(account)}, for ${r.party.name}` : `${label}, ${shortAccount(account)}`;
  if (r.party) return `${label}, ${r.party.name}`;
  return label;
}

const total = (items: PendingTxn[]): string | null => {
  const cur = items[0]?.currency;
  if (!cur || items.some((t) => t.currency !== cur)) return null;
  return plainAmount({ amountMinor: items.reduce((a, t) => a + t.amountMinor, 0), currency: cur });
};

/** "40 payments to Facebook, ₹1,24,000.00 in total" (no total when the currencies differ). */
export function groupTitle(items: PendingTxn[]): string {
  const t = items[0];
  const head = `${items.length} payment${items.length === 1 ? '' : 's'} ${t.direction === 'in' ? 'from' : 'to'} ${titleOf(t)}`;
  const sum = total(items);
  return sum ? `${head}, ${sum} in total` : head;
}

/** Cards for groups of similar items; the remembered answer is offered only when it can be given in bulk to all of them. */
export function groupCards(items: PendingTxn[], rules: Rule[]): GroupCard[] {
  return groupSimilar(items, rules).map((g) => {
    const allowed = new Set(bulkActions(g.items).map((a) => a.type));
    const s = g.suggestion && g.suggestion.type && allowed.has(g.suggestion.type) ? g.suggestion : null;
    const first = g.items[0];
    return {
      key: g.key,
      count: g.items.length,
      title: groupTitle(g.items),
      answer: s ? `Suggested: ${answerText(s, first.direction, first.accountType)}` : 'Choose what these were',
    };
  });
}

/** "₹20.00 to ₹12,000.00" over the rupee amounts (lowest to highest), "₹500.00" for one, null for none. */
export function amountRange(items: Pick<PendingTxn, 'amountMinor' | 'currency'>[]): string | null {
  const inr = items.filter((t) => t.currency === 'INR').map((t) => t.amountMinor);
  if (!inr.length) return null;
  const lo = Math.min(...inr);
  const hi = Math.max(...inr);
  return lo === hi ? formatInr(lo) : `${formatInr(lo)} to ${formatInr(hi)}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 done, 1 saved to send later, 2 need your attention" (ids are unique in a BulkResult). */
export function bulkSummary(r: BulkResult): string {
  const parts = [`${r.done.length} done`];
  if (r.queued.length) parts.push(`${r.queued.length} saved to send later`);
  if (r.failed.length) parts.push(plural(r.failed.length, 'needs your attention', 'need your attention'));
  if (r.skipped.length) parts.push(plural(r.skipped.length, 'was already answered', 'were already answered'));
  return parts.join(', ');
}

const DOCTYPE_NOTE = /\s*\((?:Payment Entry|Journal Entry|Purchase Invoice|Sales Invoice)\)/g;
// Document names: "PE-9", "ACC-PAY-2026-00012", "JV/25-26/0001", "PINV/0042".
const DOC_ID = '[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)*[-/]\\d+';

/** A runner or ERPNext message without document ids or document type names (shown as plain text). */
export function plainFailure(message: string): string {
  return message
    .replace(DOCTYPE_NOTE, '')
    .replace(/\b(?:the|a) (?:Payment Entry|Journal Entry)\b/g, 'the entry')
    .replace(/\b(?:Payment Entry|Journal Entry)\b/g, 'entry')
    .replace(/\ba Purchase Invoice\b/g, 'a bill')
    .replace(/\ba Sales Invoice\b/g, 'an invoice')
    .replace(/\bPurchase Invoice\b/g, 'bill')
    .replace(/\bSales Invoice\b/g, 'invoice')
    .replace(new RegExp(`^${DOC_ID}(?:,\\s*${DOC_ID})*(?![\\w/-])`), 'An entry')
    .replace(new RegExp(`(\\b[Aa]n entry)\\s+${DOC_ID}(?![\\w/-])`, 'g'), '$1')
    .replace(new RegExp(`\\s*\\b${DOC_ID}(?![\\w/-]),?`, 'g'), '')
    .replace(/\s*\(\s*\)/g, '')
    .replace(/\s+([;,.:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The heading of a bulk result: never "Done" when nothing was done. */
export function bulkTitle(r: BulkResult): string {
  if (r.done.length) return 'Done';
  if (r.failed.length) return 'Needs your attention';
  if (r.queued.length) return 'Saved to send later';
  return 'Already answered';
}

export type ChoiceSettings = { mappings: AccountMapping[]; company: string; drawingsAccount: string; today: string };

/** The answers of the single flow for `choice` (each item keeps its own account). */
function draftOf(txn: PendingTxn, choice: ActionChoice, mappings: AccountMapping[]): FlowDraft {
  const d: FlowDraft = { action: choice.type };
  const mapping = resolveMapping(mappings, txn);
  if (mapping) d.mapping = mapping;
  if (choice.type === 'expense') {
    d.account = choice.expenseAccount;
    if (choice.party) d.party = choice.party;
  } else if (choice.type === 'other_income') d.account = choice.incomeAccount;
  else if (choice.type === 'supplier_payment') d.party = choice.party;
  return d;
}

/**
 * The planner for answering many items with one choice, built exactly as the Confirm screen builds a plan
 * (planFor: own account, company, drawings, today; a foreign amount without rupees throws). May throw PlanError.
 */
export function planChoice(s: ChoiceSettings): (txn: PendingTxn, choice: ActionChoice) => ActionPlan {
  return (txn, choice) => planFor(txn, draftOf(txn, choice, s.mappings), { company: s.company, drawingsAccount: s.drawingsAccount, today: s.today }).plan;
}

/** True when rule `r` gives exactly answer `c` (same action, party and account). */
export const ruleHasAnswer = (r: Rule, c: ActionChoice) => {
  const party = 'party' in c ? c.party : undefined;
  const account = c.type === 'expense' ? c.expenseAccount : c.type === 'other_income' ? c.incomeAccount : undefined;
  return r.action === c.type && JSON.stringify(r.party ?? null) === JSON.stringify(party ?? null) && (r.account ?? null) === (account ?? null);
};

/**
 * The rule to save when the user says "Do this automatically" for pattern `key` after answering `done` with
 * `choice`: the stored rule with the same answer switched on, else one learned from the largest rupee item done.
 * Null when the answer may not be automatic or nothing was done.
 */
export function automaticRule(rules: Rule[], key: string, choice: ActionChoice, done: PendingTxn[]): Rule | null {
  if (!AUTO_ACTIONS.has(choice.type)) return null;
  const mine = done.filter((t) => nameKey(t) === key);
  if (!mine.length) return null;
  const stored = rules.find((r) => r.matchKey === key);
  if (stored && ruleHasAnswer(stored, choice) && stored.currency === 'INR' && stored.maxAmountMinor !== undefined) return { ...stored, auto: true };
  const inr = mine.filter((t) => t.currency === 'INR');
  const largest = (inr.length ? inr : mine).reduce((a, t) => (t.amountMinor > a.amountMinor ? t : a));
  const learned = learnRule(largest, choice, rules).find((r) => r.matchKey === key && r.action === choice.type);
  return learned ? { ...learned, auto: true } : null;
}
