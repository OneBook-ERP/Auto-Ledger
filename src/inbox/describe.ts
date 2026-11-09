// Label / value rows for the confirm screen, read from the exact plan steps that will be sent, and the detail
// screen's "may already be booked" warning. Pure.
import { SIMILAR_DAYS, dayNumber } from '../core/similar';
import type { PlanStep } from '../core/types';
import type { DupFlag } from '../ingest/dupCheck';
import type { Detail } from '../ui/DetailCard';
import { formatInr } from '../ui/format';
import { longDate } from './format';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const money = (major: unknown) => formatInr(Math.round(Number(major) * 100));
const NAME_FIELDS = ['customer_name', 'supplier_name', 'first_name', 'employee_name'];

/** customer_group -> "Customer group" (fallback when ERPNext gave no label). */
const humanize = (f: string) => (f.charAt(0).toUpperCase() + f.slice(1)).replace(/_/g, ' ');

export function stepTitle(s: PlanStep): string {
  return s.kind === 'create_party' ? `New ${s.doctype}` : s.doctype;
}

/** `labels`: human labels of a new party's fields (from getRequiredFields); raw field names are never shown. */
export function describeStep(s: PlanStep, labels: Record<string, string> = {}): Detail[] {
  const b = s.body;
  if (s.kind === 'create_party') {
    const nameKey = NAME_FIELDS.find((k) => str(b[k]));
    const rows: Detail[] = [{ label: 'Name', value: nameKey ? str(b[nameKey]) : '' }];
    for (const [k, v] of Object.entries(b)) if (k !== nameKey) rows.push({ label: labels[k] ?? humanize(k), value: str(v) });
    return rows;
  }
  const rows: Detail[] = [];
  if (s.doctype === 'Payment Entry') {
    const party = b.party ? `${str(b.party)} (${str(b.party_type)})` : '';
    const allRefs = Array.isArray(b.references) ? (b.references as Record<string, unknown>[]) : [];
    // A customer advance for Sales Orders reads "Advance for order X (₹...)"; the document type is never shown.
    const orders = allRefs.filter((r) => r.reference_doctype === 'Sales Order');
    if (b.payment_type === 'Receive') {
      rows.push({ label: 'Money in from', value: party });
      rows.push({ label: 'Amount', value: money(b.paid_amount), strong: true });
      if (orders.length) rows.push({ label: 'Advance for', value: orders.map((r) => `order ${str(r.reference_name)} (${money(r.allocated_amount)})`).join(', ') });
      rows.push({ label: 'Into account', value: str(b.paid_to) });
    } else if (b.payment_type === 'Pay') {
      rows.push({ label: 'Paid to', value: party });
      rows.push({ label: 'Amount', value: money(b.paid_amount), strong: true });
      rows.push({ label: 'From account', value: str(b.paid_from) });
    } else {
      rows.push({ label: 'From account', value: str(b.paid_from) });
      rows.push({ label: 'To account', value: str(b.paid_to) });
      rows.push({ label: 'Amount', value: money(b.paid_amount), strong: true });
    }
    const refs = allRefs.filter((r) => r.reference_doctype !== 'Sales Order');
    if (refs.length) rows.push({ label: 'Against', value: refs.map((r) => `${str(r.reference_name)} (${money(r.allocated_amount)})`).join(', ') });
    rows.push({ label: 'Mode of payment', value: str(b.mode_of_payment) });
    rows.push({ label: 'Date', value: longDate(str(b.posting_date)) });
    rows.push({ label: 'Reference', value: str(b.reference_no), mono: true });
    return rows;
  }
  const lines = Array.isArray(b.accounts) ? (b.accounts as Record<string, unknown>[]) : [];
  let amount: unknown = 0;
  for (const l of lines) {
    const acc = l.party ? `${str(l.account)} (${str(l.party)})` : str(l.account);
    if (l.debit_in_account_currency !== undefined) {
      rows.push({ label: 'Debit', value: acc });
      amount = l.debit_in_account_currency;
    } else rows.push({ label: 'Credit', value: acc });
  }
  rows.push({ label: 'Amount', value: money(amount), strong: true });
  rows.push({ label: 'Date', value: longDate(str(b.posting_date)) });
  rows.push({ label: 'Reference', value: str(b.cheque_no), mono: true });
  return rows;
}

export const DUPLICATE_TITLE = 'This may already be in ERPNext';
export const DUPLICATE_REFERENCE = 'An entry with the same reference number as this payment is already there.';
export const DUPLICATE_STRONG = 'An entry for the same amount, on the same day, with the same name is already there.';
export const DUPLICATE_WEAK = 'An entry for the same amount, within 3 days of this one, is already there.';
export const UNCHECKED_NOTE = 'We could not check older entries in ERPNext for this one.';

/** The "may already be booked" warning of the detail screen (warn only: nothing is disabled), or null. */
export function duplicateWarning(flag: DupFlag | null): { title: string; message: string; doc: { doctype: string; name: string } } | null {
  if (!flag) return null;
  const message = flag.why === 'reference' ? DUPLICATE_REFERENCE : flag.strength === 'strong' ? DUPLICATE_STRONG : DUPLICATE_WEAK;
  return { title: DUPLICATE_TITLE, message, doc: { doctype: flag.doctype, name: flag.name } };
}

/**
 * The muted "could not check" line: the last check was capped at `checkedFrom` and this item's window (its date
 * minus 3 days) reaches that date or earlier, so an older entry may have been missed. Null otherwise.
 */
export function uncheckedNote(occurredOn: string, checkedFrom: string | null): string | null {
  if (!checkedFrom) return null;
  const day = dayNumber(occurredOn);
  const from = dayNumber(checkedFrom);
  if (day === null || from === null) return null;
  return day - SIMILAR_DAYS <= from ? UNCHECKED_NOTE : null;
}
