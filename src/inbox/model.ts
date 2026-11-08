// Inbox view-model: rows, sections, header and notices from repo data. Pure; the clock is passed in.
import { suggest } from '../core/suggest';
import type { AccountMapping, PendingTxn, Rule } from '../core/types';
import { resolveMapping } from '../ingest/pipeline';
import { amountA11y, accountLabel, istToday, kindLabel, relativeAgo, signedAmount, titleOf, whenLabel } from './format';
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
};

export type InboxRow = {
  id: string; title: string; subtitle: string; amountText: string; amountA11y: string; direction: 'in' | 'out'; chip: ChipView;
};
export type InboxModel = {
  empty: boolean;
  countLabel: string;
  trustLine: string;
  rows: InboxRow[];
  sections: { title: string; rows: InboxRow[] }[];
  unreadText: string | null;
  unknownAccounts: { last4: string; text: string }[];
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
  for (const t of newestFirst(i.pending)) groups[bucket(t)].push(t);
  const toRow = (t: PendingTxn): InboxRow => {
    const mapping = resolveMapping(i.mappings, t);
    const chip: ChipView = queued.has(t.id)
      ? { text: 'Answer saved, waiting to send', tone: 'plain' }
      : chipFor(t, suggest(t, i.rules, [], []));
    return {
      id: t.id,
      title: titleOf(t),
      subtitle: [kindLabel(t.kind), accountLabel(t, mapping), whenLabel(t, today)].join(' · '),
      amountText: signedAmount(t),
      amountA11y: amountA11y(t),
      direction: t.direction,
      chip,
    };
  };
  const sections = groups.map((g, k) => ({ title: TITLES[k] as string, rows: g.map(toRow) })).filter((s) => s.rows.length > 0);
  const rows = sections.flatMap((s) => s.rows);
  const n = rows.length;
  const drafts = `${i.createdCount} draft${i.createdCount === 1 ? '' : 's'} waiting for your accountant`;
  const synced = i.lastSyncedAt === null ? 'Not synced yet' : `Synced ${relativeAgo(i.now, i.lastSyncedAt)}`;
  return {
    empty: n === 0,
    countLabel: n === 0 ? 'Nothing to answer' : `${n} to answer`,
    trustLine: `${synced} · ${drafts}`,
    rows,
    sections,
    unreadText: i.unreadCount > 0 ? `${i.unreadCount} message${i.unreadCount === 1 ? '' : 's'} could not be read` : null,
    unknownAccounts: i.unknownAccounts.map((l) => ({ last4: l, text: `Unrecognised account ending ${l}: add it in Settings` })),
  };
}
