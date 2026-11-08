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
): Promise<{ name: string; glAccount: string; bankAccountNo: string | null; isCompanyAccount: boolean; bank: string | null }[]> {
  const rows = await list<{ name: string; account: string; bank_account_no: string | null; is_company_account: number | boolean; bank: string | null }>(c, 'Bank Account', {
    fields: ['name', 'account', 'bank_account_no', 'is_company_account', 'bank'],
    filters: [['company', '=', company]],
    limit_page_length: 0,
  });
  return rows.map((r) => ({ name: r.name, glAccount: r.account, bankAccountNo: r.bank_account_no ?? null, isCompanyAccount: !!r.is_company_account, bank: r.bank ?? null }));
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

/** Enabled Modes of Payment (R18: the setup wizard lets the user pick a default per account). */
export async function listModesOfPayment(c: ErpClient): Promise<{ name: string; type: string | null }[]> {
  const rows = await list<{ name: string; type: string | null }>(c, 'Mode of Payment', {
    fields: ['name', 'type'],
    filters: [['enabled', '=', 1]],
    order_by: 'name asc',
    limit_page_length: 0,
  });
  return rows.map((r) => ({ name: r.name, type: r.type ?? null }));
}

const NAME_FIELD: Record<PartyRef['doctype'], string> = { Customer: 'customer_name', Supplier: 'supplier_name', Employee: 'employee_name' };

/** `name` is the document id (may be a naming series such as HR-EMP-00007); `displayName` is the
 *  customer_name / supplier_name / employee_name (falls back to `name` when empty). */
export async function searchParties(
  c: ErpClient,
  doctype: PartyRef['doctype'],
  q: string,
  exact?: boolean,
): Promise<(PartyRef & { displayName: string })[]> {
  const field = NAME_FIELD[doctype];
  const like = `%${q}%`;
  // exact: equality on the display-name field (no LIKE wildcards), for recovery lookups.
  const query = exact
    ? { fields: ['name', field], filters: [[field, '=', q]], order_by: 'creation asc', limit_page_length: 20 }
    : { fields: ['name', field], or_filters: [['name', 'like', like], [field, 'like', like]], limit_page_length: 20 };
  const rows = await list<Record<string, unknown> & { name: string }>(c, doctype, query);
  return rows.map((r) => {
    const dn = r[field];
    return { doctype, name: r.name, displayName: typeof dn === 'string' && dn.trim() ? dn : r.name };
  });
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
  // docstatus is forced to 0: this app never submits, whatever the caller passed.
  const r = await c.post<{ data?: { name?: string } }>(resource(doctype), { ...body, docstatus: 0 });
  const name = r?.data?.name;
  if (typeof name !== 'string' || !name) throw unexpectedResponse();
  return { name };
}

export type UtrHit = { doctype: string; name: string; docstatus: number };

const UTR_FIELDS = [['Payment Entry', 'reference_no'], ['Journal Entry', 'cheque_no']] as const;
/** Per doctype: more than this many documents with one reference is not something this app relies on. */
export const UTR_HITS_PER_DOCTYPE = 20;

/**
 * Every non-cancelled Payment Entry (reference_no) and Journal Entry (cheque_no) carrying `reference`, Payment
 * Entries first, each doctype oldest first (creation asc), up to 20 per doctype. A real UTR can be shared by
 * several txns (a reversal or refund, both legs of an own-account transfer), so callers choose among the hits.
 * A hit may be docstatus 0 (draft) OR 1 (submitted by the accountant): callers must read `docstatus`.
 */
export async function findDraftsByUtr(c: ErpClient, reference: string): Promise<UtrHit[]> {
  const out: UtrHit[] = [];
  for (const [doctype, field] of UTR_FIELDS) {
    const rows = await list<{ name: string; docstatus: number }>(c, doctype, {
      fields: ['name', 'docstatus'],
      filters: [[field, '=', reference], ['docstatus', '!=', 2]],
      order_by: 'creation asc',
      limit_page_length: UTR_HITS_PER_DOCTYPE,
    });
    for (const r of rows) out.push({ doctype, name: r.name, docstatus: r.docstatus });
  }
  return out;
}

/**
 * Exact match (idempotency for the app's own documents): the first of findDraftsByUtr, or null. Cancelled
 * documents (docstatus 2) are ignored so they never block a new draft.
 */
export async function findDraftByUtr(c: ErpClient, reference: string): Promise<UtrHit | null> {
  return (await findDraftsByUtr(c, reference))[0] ?? null;
}

/** The fields of a Payment Entry / Journal Entry the runner compares with a planned document (KL1). */
export type DraftSummary = {
  doctype: string;
  name: string;
  docstatus: number;
  company: string | null;
  paymentType: string | null;
  paidFrom: string | null;
  paidTo: string | null;
  /** Minor units (paise). */
  paidAmountMinor: number | null;
  partyType: string | null;
  party: string | null;
  /** Journal Entry: total debit in minor units. */
  totalDebitMinor: number | null;
};

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const minorOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return toMinor(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return toMinor(v);
  return null;
};

/** Reads one document (GET /api/resource/{doctype}/{name}) and returns the fields of DraftSummary. */
export async function getDraftSummary(c: ErpClient, doctype: string, name: string): Promise<DraftSummary> {
  const r = await c.get<{ data?: Record<string, unknown> }>(`${resource(doctype)}/${encodeSegment(name)}`);
  const d = r?.data;
  if (!d || typeof d !== 'object' || typeof d.docstatus !== 'number') throw unexpectedResponse();
  return {
    doctype,
    name,
    docstatus: d.docstatus,
    company: str(d.company),
    paymentType: str(d.payment_type),
    paidFrom: str(d.paid_from),
    paidTo: str(d.paid_to),
    paidAmountMinor: minorOf(d.paid_amount),
    partyType: str(d.party_type),
    party: str(d.party),
    totalDebitMinor: minorOf(d.total_debit),
  };
}

export async function deleteDraft(c: ErpClient, doctype: string, name: string): Promise<void> {
  const path = `${resource(doctype)}/${encodeSegment(name)}`;
  const r = await c.get<{ data?: { docstatus?: number } }>(path);
  const docstatus = r.data?.docstatus;
  if (typeof docstatus !== 'number') throw unexpectedResponse();
  if (docstatus !== 0) throw new NotDraftError(doctype, name, docstatus);
  await c.delete(path);
}

const STATUS_CHUNK = 50;

/**
 * Keyed `${doctype}:${name}`; names are de-duplicated and requested 50 per call per doctype (long URLs
 * fail with 414). A missing key means the document was deleted or is not accessible to this user.
 */
export async function getDocStatuses(c: ErpClient, refs: { doctype: string; name: string }[]): Promise<Record<string, number>> {
  const byType = new Map<string, Set<string>>();
  for (const r of refs) {
    if (!byType.has(r.doctype)) byType.set(r.doctype, new Set());
    byType.get(r.doctype)!.add(r.name);
  }
  const out: Record<string, number> = {};
  for (const [doctype, set] of byType) {
    const names = [...set];
    for (let i = 0; i < names.length; i += STATUS_CHUNK) {
      const rows = await list<{ name: string; docstatus: number }>(c, doctype, {
        fields: ['name', 'docstatus'],
        filters: [['name', 'in', names.slice(i, i + STATUS_CHUNK)]],
        limit_page_length: 0,
      });
      for (const row of rows) out[`${doctype}:${row.name}`] = row.docstatus;
    }
  }
  return out;
}
