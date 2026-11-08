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
  if (ds.includes(2)) return { label: 'Cancelled in ERPNext', tone: 'error', hint: 'The draft was cancelled in ERPNext. Put this message back in your Inbox to answer it again.' };
  if (ds.includes(DOC_MISSING)) {
    return { label: 'Not found in ERPNext', tone: 'warn', hint: 'ERPNext no longer shows this entry. It may have been deleted, or your user may not be allowed to see it.' };
  }
  if (ds.includes(1)) return { label: 'Partly submitted', tone: 'info', hint: 'Your accountant submitted some of these entries. Undo is no longer possible.' };
  return { label: 'Draft', tone: 'info' };
}

/** Undo is offered only while every document is still a draft. */
export const canUndo = (t: PendingTxn) => t.state === 'created' && t.createdDocs.length > 0 && t.createdDocs.every((d) => d.docstatus === 0);
/** Cancelled or missing documents: the entry can go back to the Inbox without a deletion. */
export const canPutBack = (t: PendingTxn) =>
  t.state === 'created' && t.createdDocs.some((d) => d.docstatus === 2 || d.docstatus === DOC_MISSING) && !t.createdDocs.some((d) => d.docstatus === 1);

export const titleOf = (t: PendingTxn) => t.counterparty?.trim() || t.merchant?.trim() || t.sender;
export const signedAmount = (t: PendingTxn, fmt: (minor: number) => string) => `${t.direction === 'in' ? '+' : '-'}${fmt(t.amountMinor)}`;
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
