// Inbox view-model: rows, sections, header and notices from repo data. Pure; the clock is passed in.
import { suggest } from '../core/suggest';
import type { AccountMapping, PendingTxn, Rule } from '../core/types';
import { resolveMapping } from '../ingest/pipeline';
import { amountA11y, accountLabel, istToday, kindLabel, relativeAgo, signedAmount, titleOf, whenLabel } from './format';
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
  const chipOf = (id: string): ChipView => {
    if (queued.has(id)) return QUEUED_CHIP;
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
  };
}
