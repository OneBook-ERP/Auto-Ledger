// Label / value rows for the confirm screen, read from the exact plan steps that will be sent. Pure.
import type { PlanStep } from '../core/types';
import type { Detail } from '../ui/DetailCard';
import { formatInr } from '../ui/format';
import { longDate } from './format';

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const money = (major: unknown) => formatInr(Math.round(Number(major) * 100));
const NAME_FIELDS = ['customer_name', 'supplier_name', 'first_name', 'employee_name'];

export function stepTitle(s: PlanStep): string {
  return s.kind === 'create_party' ? `New ${s.doctype}` : s.doctype;
}

export function describeStep(s: PlanStep): Detail[] {
  const b = s.body;
  if (s.kind === 'create_party') {
    const nameKey = NAME_FIELDS.find((k) => str(b[k]));
    const rows: Detail[] = [{ label: 'Name', value: nameKey ? str(b[nameKey]) : '' }];
    for (const [k, v] of Object.entries(b)) if (k !== nameKey) rows.push({ label: k, value: str(v) });
    return rows;
  }
  const rows: Detail[] = [];
  if (s.doctype === 'Payment Entry') {
    const party = b.party ? `${str(b.party)} (${str(b.party_type)})` : '';
    if (b.payment_type === 'Receive') {
      rows.push({ label: 'Money in from', value: party });
      rows.push({ label: 'Amount', value: money(b.paid_amount), strong: true });
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
    const refs = Array.isArray(b.references) ? (b.references as Record<string, unknown>[]) : [];
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
