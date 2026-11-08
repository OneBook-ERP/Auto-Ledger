// ERPNext document operations. Contract: docs/spike-report.md section B. ErpClient does not encode
// paths, so every document path segment goes through encodeSegment.
import type { OpenInvoice, PartyRef } from '../core/types';
import { ErpClient, ErpValidationError, encodeSegment, unexpectedResponse } from './client';

export { getBankBalance, getReceivablesPayables, toMinor } from './reports';
import { toMinor } from './reports';

/** deleteDraft refused: the document is submitted or cancelled. */
export class NotDraftError extends Error {
  constructor(readonly doctype: string, readonly name: string, readonly docstatus: number) {
    super('This entry is no longer a draft in ERPNext, so it cannot be deleted from the app.');
    this.name = 'NotDraftError';
  }
}

const resource = (doctype: string) => `/api/resource/${encodeSegment(doctype)}`;

async function list<T>(c: ErpClient, doctype: string, params: Record<string, unknown>): Promise<T[]> {
  const r = await c.get<{ data?: T[] }>(resource(doctype), params);
  if (!Array.isArray(r.data)) throw unexpectedResponse();
  return r.data;
}

export async function listCompanies(c: ErpClient): Promise<{ name: string; currency: string }[]> {
  const rows = await list<{ name: string; default_currency: string }>(c, 'Company', { fields: ['name', 'default_currency'], limit_page_length: 0 });
  return rows.map((r) => ({ name: r.name, currency: r.default_currency }));
}

export async function listBankAccounts(
  c: ErpClient,
  company: string,
): Promise<{ name: string; glAccount: string; bankAccountNo: string | null; isCompanyAccount: boolean }[]> {
  const rows = await list<{ name: string; account: string; bank_account_no: string | null; is_company_account: number | boolean }>(c, 'Bank Account', {
    fields: ['name', 'account', 'bank_account_no', 'is_company_account'],
    filters: [['company', '=', company]],
    limit_page_length: 0,
  });
  return rows.map((r) => ({ name: r.name, glAccount: r.account, bankAccountNo: r.bank_account_no ?? null, isCompanyAccount: !!r.is_company_account }));
}

/** Non-group (postable) ledger accounts only. */
export async function listLedgerAccounts(
  c: ErpClient,
  company: string,
  f: { rootType?: 'Asset' | 'Liability' | 'Equity' | 'Income' | 'Expense' },
): Promise<{ name: string; accountType: string | null }[]> {
  const filters: unknown[][] = [['company', '=', company], ['is_group', '=', 0]];
  if (f.rootType) filters.push(['root_type', '=', f.rootType]);
  const rows = await list<{ name: string; account_type: string | null }>(c, 'Account', { fields: ['name', 'account_type'], filters, limit_page_length: 0 });
  return rows.map((r) => ({ name: r.name, accountType: r.account_type ?? null }));
}

const NAME_FIELD: Record<PartyRef['doctype'], string> = { Customer: 'customer_name', Supplier: 'supplier_name', Employee: 'employee_name' };

export async function searchParties(c: ErpClient, doctype: PartyRef['doctype'], q: string): Promise<PartyRef[]> {
  const like = `%${q}%`;
  const rows = await list<{ name: string }>(c, doctype, {
    fields: ['name'],
    or_filters: [['name', 'like', like], [NAME_FIELD[doctype], 'like', like]],
    limit_page_length: 20,
  });
  return rows.map((r) => ({ doctype, name: r.name }));
}

const nonEmpty = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export async function createParty(c: ErpClient, doctype: PartyRef['doctype'], fields: Record<string, unknown>): Promise<PartyRef> {
  // The server answers a Customer without customer_name with HTTP 500 (spike B.0 #8), so check here first.
  const required = doctype === 'Employee' ? (nonEmpty(fields.first_name) || nonEmpty(fields.employee_name) ? null : 'first_name') : NAME_FIELD[doctype];
  if (required && !nonEmpty(fields[required])) {
    throw new ErpValidationError(`Enter a name for the ${doctype.toLowerCase()}.`, 0, [required]);
  }
  const r = await c.post<{ data?: { name?: string } }>(resource(doctype), fields);
  const name = r?.data?.name;
  if (typeof name !== 'string' || !name) throw unexpectedResponse();
  return { doctype, name };
}

export async function getRequiredFields(c: ErpClient, doctype: string): Promise<{ fieldname: string; label: string; fieldtype: string }[]> {
  const r = await c.get<{ docs?: { name: string; fields?: { fieldname: string; label?: string; fieldtype: string; reqd?: number | string; default?: unknown }[] }[] }>(
    '/api/method/frappe.desk.form.load.getdoctype',
    { doctype, with_parent: 1 },
  );
  const main = Array.isArray(r.docs) ? r.docs.find((d) => d.name === doctype) : undefined;
  if (!main || !Array.isArray(main.fields)) throw unexpectedResponse();
  // reqd with no default are the fields the user must supply (spike B.7); mandatory_depends_on is ignored.
  return main.fields
    .filter((f) => Number(f.reqd) === 1 && (f.default === undefined || f.default === null || f.default === ''))
    .map((f) => ({ fieldname: f.fieldname, label: f.label ?? f.fieldname, fieldtype: f.fieldtype }));
}

export async function listOpenInvoices(c: ErpClient, partyType: 'Customer' | 'Supplier', party: string): Promise<OpenInvoice[]> {
  const doctype = partyType === 'Customer' ? 'Sales Invoice' : 'Purchase Invoice';
  const rows = await list<{ name: string; outstanding_amount: number; due_date: string | null }>(c, doctype, {
    fields: ['name', 'outstanding_amount', 'due_date'],
    filters: [['docstatus', '=', 1], ['outstanding_amount', '>', 0], [partyType === 'Customer' ? 'customer' : 'supplier', '=', party]],
    order_by: 'due_date asc',
    limit_page_length: 0,
  });
  return rows.map((r) => ({ doctype, name: r.name, outstandingMinor: toMinor(r.outstanding_amount), dueDate: r.due_date ?? '' }));
}

/** Creates a DRAFT only (never submits). Any 2xx is success. */
export async function createDraft(c: ErpClient, doctype: 'Payment Entry' | 'Journal Entry', body: Record<string, unknown>): Promise<{ name: string }> {
  const r = await c.post<{ data?: { name?: string } }>(resource(doctype), body);
  const name = r?.data?.name;
  if (typeof name !== 'string' || !name) throw unexpectedResponse();
  return { name };
}

/** Exact match (idempotency for the app's own documents); docstatus is returned, not filtered on. */
export async function findDraftByUtr(c: ErpClient, reference: string): Promise<{ doctype: string; name: string; docstatus: number } | null> {
  for (const [doctype, field] of [['Payment Entry', 'reference_no'], ['Journal Entry', 'cheque_no']] as const) {
    const rows = await list<{ name: string; docstatus: number }>(c, doctype, {
      fields: ['name', 'docstatus'],
      filters: [[field, '=', reference]],
      limit_page_length: 1,
    });
    if (rows.length > 0) return { doctype, name: rows[0].name, docstatus: rows[0].docstatus };
  }
  return null;
}

export async function deleteDraft(c: ErpClient, doctype: string, name: string): Promise<void> {
  const path = `${resource(doctype)}/${encodeSegment(name)}`;
  const r = await c.get<{ data?: { docstatus?: number } }>(path);
  const docstatus = r.data?.docstatus;
  if (typeof docstatus !== 'number') throw unexpectedResponse();
  if (docstatus !== 0) throw new NotDraftError(doctype, name, docstatus);
  await c.delete(path);
}

/** Keyed `${doctype}:${name}`; one request per doctype. Documents that no longer exist are absent. */
export async function getDocStatuses(c: ErpClient, refs: { doctype: string; name: string }[]): Promise<Record<string, number>> {
  const byType = new Map<string, string[]>();
  for (const r of refs) byType.set(r.doctype, [...(byType.get(r.doctype) ?? []), r.name]);
  const out: Record<string, number> = {};
  for (const [doctype, names] of byType) {
    const rows = await list<{ name: string; docstatus: number }>(c, doctype, {
      fields: ['name', 'docstatus'],
      filters: [['name', 'in', names]],
      limit_page_length: 0,
    });
    for (const row of rows) out[`${doctype}:${row.name}`] = row.docstatus;
  }
  return out;
}
