// Display text for transactions: amounts, dates, account and kind labels. Pure; the clock is passed in.
import type { AccountMapping, ParsedTxn, TxnKind } from '../core/types';
import { MONTHS, formatInr } from '../ui/format';

const IST_OFFSET_MS = 330 * 60_000;

/** Today's date in Asia/Kolkata (no DST) as YYYY-MM-DD. */
export function istToday(nowMs: number): string {
  return new Date(nowMs + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Western grouping for a foreign amount: 1234567 minor -> "12,345.67". */
function westernMoney(minor: number): string {
  const abs = Math.abs(Math.round(minor));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** "₹30,000.00" or "USD 100.00" (unsigned). */
export function plainAmount(txn: Pick<ParsedTxn, 'amountMinor' | 'currency'>): string {
  return txn.currency === 'INR' ? formatInr(txn.amountMinor) : `${txn.currency} ${westernMoney(txn.amountMinor)}`;
}

/** "+₹30,000.00" for money in, "−₹30,000.00" (minus sign) for money out. */
export function signedAmount(txn: Pick<ParsedTxn, 'amountMinor' | 'currency' | 'direction'>): string {
  return `${txn.direction === 'in' ? '+' : '−'}${plainAmount(txn)}`;
}

/** What a screen reader says: "₹30,000.00 received". */
export function amountA11y(txn: Pick<ParsedTxn, 'amountMinor' | 'currency' | 'direction'>): string {
  return `${plainAmount(txn)} ${txn.direction === 'in' ? 'received' : 'paid'}`;
}

/** ERPNext account / bank account names end in " - <company abbreviation>"; drop it for display. */
export function shortAccount(name: string): string {
  const i = name.lastIndexOf(' - ');
  return i > 0 ? name.slice(0, i) : name;
}

/** "IDFC First …6507", or "Account not set" when no saved account matches. */
export function accountLabel(txn: Pick<ParsedTxn, 'accountLast4'>, mapping: AccountMapping | null): string {
  if (!mapping) return 'Account not set';
  const name = shortAccount(mapping.bankAccount);
  return txn.accountLast4 ? `${name} …${txn.accountLast4}` : name;
}

const KIND: Record<TxnKind, string> = {
  ca_credit: 'Credit', ca_debit: 'Debit', neft_confirm: 'NEFT', card_spend: 'Card spend', card_si_paid: 'Standing instruction',
};
export const kindLabel = (k: TxnKind) => KIND[k];

export function titleOf(txn: Pick<ParsedTxn, 'counterparty' | 'merchant' | 'direction'>): string {
  return txn.counterparty ?? txn.merchant ?? (txn.direction === 'in' ? 'Money received' : 'Money paid');
}

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function dateText(iso: string, withYear: boolean): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

/** Inbox row time: "10:42 am" today, "yesterday 6:02 pm", "5 Nov, 12:05 am", "7 Dec 2025" (other year). */
export function whenLabel(txn: Pick<ParsedTxn, 'occurredOn' | 'occurredTime'>, today: string): string {
  const diff = dayDiff(txn.occurredOn, today);
  const t = txn.occurredTime ? clock(txn.occurredTime) : null;
  if (diff === 0) return t ?? 'today';
  if (diff === 1) return t ? `yesterday ${t}` : 'yesterday';
  const date = dateText(txn.occurredOn, txn.occurredOn.slice(0, 4) !== today.slice(0, 4));
  return t ? `${date}, ${t}` : date;
}

/** Transaction screen: "8 Nov 2026, 10:42 am". */
export function dateTimeLabel(txn: Pick<ParsedTxn, 'occurredOn' | 'occurredTime'>): string {
  const date = dateText(txn.occurredOn, true);
  return txn.occurredTime ? `${date}, ${clock(txn.occurredTime)}` : date;
}

/** "8 Nov 2026" from YYYY-MM-DD. */
export const longDate = (iso: string) => dateText(iso, true);

export function relativeAgo(now: number, then: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 60) return 'just now';
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}
