/** The one minus sign used for money out in every list and card (a true minus, not a hyphen). */
export const MINUS = '\u2212';

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The one date format: "8 Nov 2026" from YYYY-MM-DD. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Formats integer paise as rupees with Indian digit grouping: 51293276 -> "₹5,12,932.76". */
export function formatInr(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100).toString();
  const paise = (abs % 100).toString().padStart(2, '0');
  const head = rupees.length > 3 ? rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + rupees.slice(-3) : rupees;
  return `${neg ? MINUS : ''}₹${head}.${paise}`;
}

/** Formats `minor` in the transaction's own currency: rupees for INR, otherwise the ISO code before the figure. */
export function formatMoney(minor: number, currency: string | null | undefined): string {
  const cur = (currency ?? '').trim().toUpperCase();
  if (!cur || cur === 'INR') return formatInr(minor);
  return formatInr(minor).replace('₹', `${cur} `);
}

/** Signed money for lists and cards: "+₹1,234.00" in, "\u2212₹1,234.00" out. `minor` is the unsigned amount. */
export function signedMoney(minor: number, currency: string | null | undefined, direction: 'in' | 'out'): string {
  return `${direction === 'in' ? '+' : MINUS}${formatMoney(Math.abs(minor), currency)}`;
}

/** A friendly name for an ERPNext document type: "Payment Entry" -> "Payment entry". */
export function friendlyDoctype(doctype: string): string {
  const t = doctype.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
}
