// Pure helpers for the Activity screen: status text, document links, grouping.
import type { PendingTxn } from '../core/types';
import { encodeSegment } from '../erp/client';
import { DOC_MISSING } from '../ingest/statusPoller';
import type { StatusTone } from '../ui';

export const PAGE_SIZE = 100;

type Doc = PendingTxn['createdDocs'][number];

/** `<siteUrl>/app/<doctype slug>/<name>`; slug = lower-case doctype with spaces turned into hyphens. */
export function docUrl(siteUrl: string, d: { doctype: string; name: string }): string {
  return `${siteUrl.replace(/\/+$/, '')}/app/${d.doctype.trim().toLowerCase().replace(/\s+/g, '-')}/${encodeSegment(d.name)}`;
}

export type RowStatus = { label: string; tone: StatusTone; hint?: string };

export function statusOf(t: PendingTxn): RowStatus {
  if (t.state === 'ignored') return { label: 'Ignored', tone: 'neutral' };
  if (t.state === 'submitted') return { label: 'Submitted', tone: 'ok' };
  const ds = t.createdDocs.map((d) => d.docstatus);
  // A submitted document outranks everything else: it cannot be undone or put back.
  if (ds.includes(1)) return { label: 'Partly submitted', tone: 'info', hint: 'Your accountant submitted some of these entries. Undo is no longer possible.' };
  if (ds.includes(2)) return { label: 'Cancelled in ERPNext', tone: 'error', hint: 'The draft was cancelled in ERPNext. Put this message back in your Inbox to answer it again.' };
  if (ds.includes(DOC_MISSING)) {
    return { label: 'Not found in ERPNext', tone: 'warn', hint: 'ERPNext no longer shows this entry. It may have been deleted, or your user may not be allowed to see it.' };
  }
  return { label: 'Draft', tone: 'info' };
}

/** Undo is offered only while every document is still a draft. */
export const canUndo = (t: PendingTxn) => t.state === 'created' && t.createdDocs.length > 0 && t.createdDocs.every((d) => d.docstatus === 0);
/** Cancelled or missing documents: the entry can go back to the Inbox without a deletion. */
export const canPutBack = (t: PendingTxn) =>
  t.state === 'created' && t.createdDocs.some((d) => d.docstatus === 2 || d.docstatus === DOC_MISSING) && !t.createdDocs.some((d) => d.docstatus === 1);

export const titleOf = (t: PendingTxn) => t.counterparty?.trim() || t.merchant?.trim() || t.sender;
export const docLines = (docs: Doc[]) => docs.map((d) => `${d.doctype} ${d.name}`);

export type Groups = { created: PendingTxn[]; submitted: PendingTxn[]; ignored: PendingTxn[]; total: number; shown: number };

/** Newest first, limited to `limit` items across all sections. */
export function groupActivity(all: PendingTxn[], limit: number): Groups {
  const rel = all
    .filter((t) => t.state === 'created' || t.state === 'submitted' || t.state === 'ignored')
    .sort((a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1));
  const shown = rel.slice(0, limit);
  return {
    created: shown.filter((t) => t.state === 'created'),
    submitted: shown.filter((t) => t.state === 'submitted'),
    ignored: shown.filter((t) => t.state === 'ignored'),
    total: rel.length,
    shown: shown.length,
  };
}

export const UNDO_CONFIRM_TITLE = 'Undo this entry?';
export const UNDO_CONFIRM_MESSAGE = 'Remove the draft from ERPNext and put this message back in your Inbox?';
export const KEEP_ADOPTED_MESSAGE = 'This entry was already in ERPNext before this app recorded it. It stays there; only the link to this message is removed.';
export const KEEP_SHARED_MESSAGE = 'This entry is also linked to another message. It stays in ERPNext; only the link to this message is removed.';

/** What Undo will really do with the drafts of `t`: delete (created here, linked to nothing else) or only unlink. */
export function removalPlan(t: PendingTxn, all: PendingTxn[]): { remove: Doc[]; keep: Doc[] } {
  const elsewhere = new Set(all.filter((x) => x.id !== t.id).flatMap((x) => x.createdDocs.map((d) => `${d.doctype}:${d.name}`)));
  const drafts = t.createdDocs.filter((d) => d.docstatus === 0);
  const isKept = (d: Doc) => d.adopted || elsewhere.has(`${d.doctype}:${d.name}`);
  return { remove: drafts.filter((d) => !isKept(d)), keep: drafts.filter(isKept) };
}

/** The confirm dialog text for `plan`, or null when nothing would be deleted. */
export function confirmText(plan: { remove: Doc[]; keep: Doc[] }): { title: string; message: string } | null {
  if (!plan.remove.length && !plan.keep.length) return null;
  const keepMsg = plan.keep.some((d) => d.adopted) ? KEEP_ADOPTED_MESSAGE : KEEP_SHARED_MESSAGE;
  if (!plan.keep.length) return { title: UNDO_CONFIRM_TITLE, message: UNDO_CONFIRM_MESSAGE };
  if (!plan.remove.length) return { title: 'Put this message back in your Inbox?', message: keepMsg };
  return { title: UNDO_CONFIRM_TITLE, message: `${UNDO_CONFIRM_MESSAGE} ${plan.keep.map((d) => d.name).join(', ')}: ${keepMsg}` };
}

export type ActivityPeriod = 'this_month' | 'last_month' | 'this_fy' | 'all';
export type ActivitySort = 'newest' | 'oldest' | 'amount_high' | 'amount_low' | 'name_az';
export type ActivityStatus = 'waiting' | 'submitted' | 'ignored';
export type ActivityFilter = { query: string; period: ActivityPeriod; direction?: 'in' | 'out'; accountLast4?: string; status?: ActivityStatus };

const STATE_OF: Record<ActivityStatus, PendingTxn['state']> = { waiting: 'created', submitted: 'submitted', ignored: 'ignored' };

const pad = (n: number) => String(n).padStart(2, '0');

/** `[from, to)` as YYYY-MM-DD strings (compared lexically), or null for no limit. */
export function periodRange(period: ActivityPeriod, today: string): [string, string] | null {
  if (period === 'all') return null;
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  if (period === 'this_month') return [`${y}-${pad(m)}-01`, m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`];
  if (period === 'last_month') {
    const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
    return [`${py}-${pad(pm)}-01`, `${y}-${pad(m)}-01`];
  }
  const fy = m >= 4 ? y : y - 1; // the financial year starts on 1 April
  return [`${fy}-04-01`, `${fy + 1}-04-01`];
}

export const searchText = (t: PendingTxn) => [t.counterparty, t.merchant, t.sender, t.utr, ...t.createdDocs.map((d) => d.name)].filter(Boolean).join('\n').toLowerCase();

/** Search (plain text, case-insensitive, trimmed), period, direction and account. Keeps the input order. */
export function filterActivity(items: PendingTxn[], f: ActivityFilter, today: string): PendingTxn[] {
  const q = f.query.trim().toLowerCase();
  const range = periodRange(f.period, today);
  return items.filter((t) => {
    if (range && (t.occurredOn < range[0] || t.occurredOn >= range[1])) return false;
    if (f.direction && t.direction !== f.direction) return false;
    if (f.status && t.state !== STATE_OF[f.status]) return false;
    if (f.accountLast4 && t.accountLast4 !== f.accountLast4) return false;
    return !q || searchText(t).includes(q);
  });
}

/** Drafts waiting for the accountant among the entries matching every filter EXCEPT status; cancelled or missing drafts are not counted (as in `totalsOf`). */
export function waitingCount(items: PendingTxn[], f: ActivityFilter, today: string): number {
  return filterActivity(items, { ...f, status: undefined }, today).filter(
    (t) => t.state === 'created' && !t.createdDocs.some((d) => d.docstatus === 2 || d.docstatus === DOC_MISSING),
  ).length;
}

/** Rupee totals in paise, for entries that count (not ignored, not cancelled or missing). Items in another currency are not added; they are counted in `foreignCount`. */
export function totalsOf(items: PendingTxn[]): { inMinor: number; outMinor: number; netMinor: number; foreignCount: number } {
  let inMinor = 0;
  let outMinor = 0;
  let foreignCount = 0;
  for (const t of items) {
    // Ignored items and drafts that were cancelled or are gone from ERPNext are not part of the books.
    if (t.state === 'ignored' || t.createdDocs.some((d) => d.docstatus === 2 || d.docstatus === DOC_MISSING)) continue;
    if ((t.currency || 'INR').toUpperCase() !== 'INR') foreignCount += 1;
    else if (t.direction === 'in') inMinor += t.amountMinor;
    else outMinor += t.amountMinor;
  }
  return { inMinor, outMinor, netMinor: inMinor - outMinor, foreignCount };
}

const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;

export type RecencyTitle = 'Today' | 'Yesterday' | 'This week' | 'Earlier';

/** Groups by how long ago `occurredOn` was; empty groups are left out and the order inside a group is kept. */
export function groupByRecency(items: PendingTxn[], today: string): { title: RecencyTitle; rows: PendingTxn[] }[] {
  const t0 = dayNumber(today);
  const buckets: Record<RecencyTitle, PendingTxn[]> = { Today: [], Yesterday: [], 'This week': [], Earlier: [] };
  for (const t of items) {
    const age = t0 - dayNumber(t.occurredOn);
    buckets[age <= 0 ? 'Today' : age === 1 ? 'Yesterday' : age <= 6 ? 'This week' : 'Earlier'].push(t);
  }
  return (['Today', 'Yesterday', 'This week', 'Earlier'] as const).filter((k) => buckets[k].length).map((k) => ({ title: k, rows: buckets[k] }));
}

const newestFirst = (a: PendingTxn, b: PendingTxn) =>
  (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : 0) || b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : -1);

export function sortActivity(items: PendingTxn[], by: ActivitySort): PendingTxn[] {
  const l = [...items];
  switch (by) {
    case 'oldest': return l.sort((a, b) => newestFirst(b, a));
    case 'amount_high': return l.sort((a, b) => b.amountMinor - a.amountMinor || newestFirst(a, b));
    case 'amount_low': return l.sort((a, b) => a.amountMinor - b.amountMinor || newestFirst(a, b));
    case 'name_az': return l.sort((a, b) => titleOf(a).toLowerCase().localeCompare(titleOf(b).toLowerCase()) || newestFirst(a, b));
    default: return l.sort(newestFirst);
  }
}

/** Today as YYYY-MM-DD in the phone's local time. */
export function isoToday(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
