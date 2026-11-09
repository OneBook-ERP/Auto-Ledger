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
  empty: boolean;
  countLabel: string;
  trustLine: string;
  rows: InboxRow[];
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
  for (const t of newestFirst(i.pending)) groups[bucket(t)].push(t);
  const toRow = (t: PendingTxn): InboxRow => {
    const mapping = resolveMapping(i.mappings, t);
    const chip: ChipView = queued.has(t.id)
      ? { text: 'Answer saved, waiting to send', tone: 'plain' }
      : chipFor(t, suggest(t, i.rules, [], []));
    // A merchant (card spend) is not a person: ask what it was, not who it is.
    if (chip.text === 'Who is this?' && t.merchant && !t.counterparty) chip.text = 'What was this?';
    return {
      id: t.id,
      title: titleOf(t),
      subtitle: [kindLabel(t.kind), accountLabel(t, mapping), whenLabel(t, today)].join(' · '),
      amountText: signedAmount(t),
      amountA11y: amountA11y(t),
      direction: t.direction,
      chip,
      kindIcon: kindIconOf(t),
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
    accountsNotice: i.unknownAccounts.length === 0 ? null : {
      last4s: i.unknownAccounts,
      text: `${i.unknownAccounts.length} account${i.unknownAccounts.length === 1 ? ' is' : 's are'} not set up: ${i.unknownAccounts.join(', ')}`,
    },
    unknownAccounts: i.unknownAccounts.map((l) => ({ last4: l, text: `Unrecognised account ending ${l}: add it in Settings` })),
  };
}
