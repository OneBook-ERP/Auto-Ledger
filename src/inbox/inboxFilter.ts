// Pure filtering of pending Inbox items. Shares the period and search logic with Activity (no RegExp from user text).
import type { PendingTxn } from '../core/types';
import { periodRange, searchText, type ActivityPeriod } from '../state/activityModel';
import { kindIconOf } from './model';

export type InboxKind = 'bank' | 'upi' | 'card';
export type InboxFilter = { query: string; period: ActivityPeriod; direction?: 'in' | 'out'; accountLast4?: string; kind?: InboxKind };

/** Search, period, direction, account and how it was paid; all must match. Keeps the input order. */
export function filterPending(items: PendingTxn[], f: InboxFilter, today: string): PendingTxn[] {
  const q = f.query.trim().toLowerCase();
  const range = periodRange(f.period, today);
  if (!q && !range && !f.direction && !f.accountLast4 && !f.kind) return items;
  return items.filter((t) => {
    if (range && (t.occurredOn < range[0] || t.occurredOn >= range[1])) return false;
    if (f.direction && t.direction !== f.direction) return false;
    if (f.accountLast4 && t.accountLast4 !== f.accountLast4) return false;
    if (f.kind && kindIconOf(t) !== f.kind) return false;
    return !q || searchText(t).includes(q);
  });
}

/** Settings in the filter sheet that differ from the default (shown on the Filters button). */
export const activeInboxFilterCount = (f: InboxFilter) => (f.direction ? 1 : 0) + (f.accountLast4 ? 1 : 0) + (f.kind ? 1 : 0);
