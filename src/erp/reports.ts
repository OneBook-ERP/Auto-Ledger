// ERPNext balances and report totals. Contract: docs/spike-report.md B.8.
import { ErpClient, unexpectedResponse } from './client';

/**
 * Decimal amount (ERPNext returns JSON numbers like 1131.5) to integer minor units (paise).
 * Works on the decimal string of the number, not on `x * 100`, so there is no binary drift;
 * Throws on NaN or unparseable input; rounds half away from zero at the 3rd decimal digit.
 */
export function toMinor(x: number | string | null | undefined): number {
  // null/undefined/'' mean "no value" (e.g. a SUM over no GL entries) and are 0; anything else must parse.
  if (x === null || x === undefined || x === '') return 0;
  const n = typeof x === 'number' ? x : Number(x);
  if (!Number.isFinite(n)) throw new Error(`Not a valid amount: ${String(x)}`);
  const s = Math.abs(n) < 1e-6 || Math.abs(n) >= 1e21 ? Math.abs(n).toFixed(10) : String(Math.abs(n));
  const [intPart, fracPart = ''] = s.split('.');
  const frac = (fracPart + '000').slice(0, 3);
  let minor = Number(intPart) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) minor += 1;
  return n < 0 && minor !== 0 ? -minor : minor;
}

function localIsoDate(d = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Book balance of a GL account in minor units (debit - credit; negative for a card that owes).
 * get_balance_on is not whitelisted in v16, so this is a GL Entry SUM through frappe.client.get_list.
 */
export async function getBankBalance(c: ErpClient, glAccount: string, company: string): Promise<number> {
  const r = await c.get<{ message?: { debit?: number | null; credit?: number | null }[] }>('/api/method/frappe.client.get_list', {
    doctype: 'GL Entry',
    fields: [{ SUM: 'debit', as: 'debit' }, { SUM: 'credit', as: 'credit' }],
    filters: [['account', '=', glAccount], ['company', '=', company], ['is_cancelled', '=', 0], ['posting_date', '<=', localIsoDate()]],
  });
  if (!Array.isArray(r.message)) throw unexpectedResponse();
  const row = r.message[0];
  return toMinor(row?.debit) - toMinor(row?.credit);
}

type ReportResult = { columns?: { fieldname?: string }[]; result?: unknown[] };

async function reportOutstandingTotal(c: ErpClient, reportName: string, company: string): Promise<number> {
  const rep = await c.call<ReportResult>('frappe.desk.query_report.run', {
    report_name: reportName,
    filters: { company, report_date: localIsoDate(), ageing_based_on: 'Due Date', range: '30, 60, 90, 120' },
    ignore_prepared_report: true,
  });
  if (!Array.isArray(rep.result) || !Array.isArray(rep.columns)) throw unexpectedResponse();
  if (rep.result.length === 0) return 0;
  // Object rows are the parties; the grand total is the positional array row. Never sum the party rows
  // or invoice outstanding amounts: the report's figure is the one net of advances (spec section 11).
  const total = rep.result.find((r): r is unknown[] => Array.isArray(r));
  const idx = rep.columns.findIndex((col) => col.fieldname === 'outstanding');
  if (!total || idx < 0) throw unexpectedResponse();
  return toMinor(total[idx] as number | null);
}

export async function getReceivablesPayables(c: ErpClient, company: string): Promise<{ receivableMinor: number; payableMinor: number }> {
  const receivableMinor = await reportOutstandingTotal(c, 'Accounts Receivable Summary', company);
  const payableMinor = await reportOutstandingTotal(c, 'Accounts Payable Summary', company);
  return { receivableMinor, payableMinor };
}
