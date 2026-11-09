// ERPNext document operations. Contract: docs/spike-report.md section B. ErpClient does not encode
// paths, so every document path segment goes through encodeSegment.
import type { BookedEntry } from '../core/similar';
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

/** A submitted, still-open Sales Order of a customer. Money in minor units (paise), company currency. */
export type OpenOrder = {
  name: string; totalMinor: number; advanceMinor: number; remainingMinor: number; deliveryDate: string | null;
  /** The order's date (transaction_date), YYYY-MM-DD. */
  orderDate: string | null;
};

const OPEN_ORDER_STATUSES = ['To Deliver and Bill', 'To Bill', 'To Deliver'];

type Amount = number | string | null | undefined;
/** Zero, empty or absent counts as "not set" (ERPNext leaves rounded_total 0 when rounding is disabled). */
const setMinor = (v: Amount): number | null => {
  const m = toMinor(v);
  return m === 0 ? null : m;
};

/**
 * Open Sales Orders of `customer` that can still take an advance: docstatus 1, status one of
 * OPEN_ORDER_STATUSES (never Closed, Cancelled or Completed), remaining above 0. Oldest first.
 * The total is what ERPNext checks an advance against (its Sales Order outstanding):
 * base_rounded_total when set, else base_grand_total (grand_total only when the base fields are absent).
 * remaining = total - advance_paid, all in paise. The server filters are repeated here so an odd reply
 * never offers a closed order.
 */
export async function listOpenSalesOrders(c: ErpClient, customer: string): Promise<OpenOrder[]> {
  const rows = await list<{
    name: string; grand_total: Amount; rounded_total: Amount; base_grand_total: Amount; base_rounded_total: Amount;
    advance_paid: Amount; delivery_date: string | null; status: string; docstatus: number; transaction_date: string | null;
  }>(c, 'Sales Order', {
    fields: [
      'name', 'grand_total', 'rounded_total', 'base_grand_total', 'base_rounded_total', 'advance_paid', 'delivery_date', 'status', 'docstatus', 'transaction_date',
    ],
    filters: [['customer', '=', customer], ['docstatus', '=', 1], ['status', 'in', OPEN_ORDER_STATUSES]],
    order_by: 'transaction_date asc, creation asc',
    limit_page_length: 0,
  });
  const out: OpenOrder[] = [];
  for (const r of rows) {
    if (r.docstatus !== 1 || !OPEN_ORDER_STATUSES.includes(r.status)) continue;
    const base = r.base_grand_total === undefined || r.base_grand_total === null ? r.grand_total : r.base_grand_total;
    const totalMinor = setMinor(r.base_rounded_total) ?? toMinor(base);
    const advanceMinor = toMinor(r.advance_paid);
    const remainingMinor = totalMinor - advanceMinor;
    if (remainingMinor <= 0) continue;
    out.push({ name: r.name, totalMinor, advanceMinor, remainingMinor, deliveryDate: r.delivery_date ?? null, orderDate: r.transaction_date ?? null });
  }
  // Array.prototype.sort is stable: equal dates keep the server's creation order; no date sorts first.
  const key = (o: OpenOrder) => o.orderDate ?? '';
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
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
  /** Journal Entry: the account rows (debit/credit in minor units, account currency); [] when there are none. */
  accounts: DraftAccountRow[];
};

export type DraftAccountRow = { account: string | null; debitMinor: number; creditMinor: number; partyType: string | null; party: string | null };

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
const minorOf = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return toMinor(v);
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return toMinor(v);
  return null;
};

function accountRow(r: Record<string, unknown>): DraftAccountRow {
  return {
    account: str(r.account),
    debitMinor: minorOf(r.debit_in_account_currency) ?? minorOf(r.debit) ?? 0,
    creditMinor: minorOf(r.credit_in_account_currency) ?? minorOf(r.credit) ?? 0,
    partyType: str(r.party_type),
    party: str(r.party),
  };
}

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
    accounts: Array.isArray(d.accounts) ? (d.accounts as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object').map(accountRow) : [],
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

/** Rows per request when reading booked entries; at most BOOKED_MAX_PAGES requests per doctype. */
export const BOOKED_PAGE_SIZE = 500;
const BOOKED_MAX_PAGES = 3;

type BookedRow = Record<string, unknown> & { name: string; docstatus: number; company?: string | null; posting_date?: string | null };

const BOOKED_SOURCES: {
  doctype: string;
  fields: string[];
  map: (r: BookedRow) => Pick<BookedEntry, 'amountMinor' | 'direction' | 'party' | 'reference'>;
}[] = [
  {
    doctype: 'Payment Entry',
    fields: ['name', 'posting_date', 'payment_type', 'paid_amount', 'received_amount', 'party', 'party_name', 'reference_no', 'docstatus', 'company'],
    // The amount on the bank side: paid from it (Pay) or received into it (Receive).
    map: (r) => ({
      amountMinor: minorOf(r.payment_type === 'Receive' ? r.received_amount : r.paid_amount) ?? 0,
      direction: r.payment_type === 'Receive' ? 'in' : r.payment_type === 'Pay' ? 'out' : null,
      party: str(r.party_name) ?? str(r.party),
      reference: str(r.reference_no),
    }),
  },
  {
    doctype: 'Journal Entry',
    fields: ['name', 'posting_date', 'total_debit', 'cheque_no', 'docstatus', 'company'],
    map: (r) => ({ amountMinor: minorOf(r.total_debit) ?? 0, direction: null, party: null, reference: str(r.cheque_no) }),
  },
  {
    doctype: 'Purchase Invoice',
    fields: ['name', 'posting_date', 'base_grand_total', 'base_rounded_total', 'supplier', 'supplier_name', 'bill_no', 'docstatus', 'company'],
    // Company currency; rounded_total is 0 when rounding is off.
    map: (r) => ({
      amountMinor: (minorOf(r.base_rounded_total) || null) ?? minorOf(r.base_grand_total) ?? 0,
      direction: 'out',
      party: str(r.supplier_name) ?? str(r.supplier),
      reference: str(r.bill_no),
    }),
  },
];

/**
 * Draft and submitted (never cancelled) Payment Entries, Journal Entries and Purchase Invoices of `company`
 * posted between `fromDate` and `toDate` (inclusive, YYYY-MM-DD), newest first per doctype. Paged
 * BOOKED_PAGE_SIZE rows at a time, at most BOOKED_MAX_PAGES requests per doctype (older rows beyond that are not
 * read). Rows of another company or with another docstatus are dropped even if the server returns them.
 * Money in paise. Read-only; used only for the "may already be booked" warning.
 */
export async function listBookedEntries(c: ErpClient, company: string, fromDate: string, toDate: string): Promise<BookedEntry[]> {
  return (await readBookedEntries(c, company, fromDate, toDate)).entries;
}

/**
 * listBookedEntries plus `checkedFrom`: null when every doctype was read completely; otherwise the latest of the
 * oldest posting dates read by the doctypes that hit the paging cap (entries before it may be missing).
 */
export async function readBookedEntries(
  c: ErpClient, company: string, fromDate: string, toDate: string,
): Promise<{ entries: BookedEntry[]; checkedFrom: string | null }> {
  const entries: BookedEntry[] = [];
  let checkedFrom: string | null = null;
  for (const src of BOOKED_SOURCES) {
    let oldest: string | null = null;
    for (let page = 0; page < BOOKED_MAX_PAGES; page += 1) {
      const rows = await list<BookedRow>(c, src.doctype, {
        fields: src.fields,
        filters: [['company', '=', company], ['docstatus', 'in', [0, 1]], ['posting_date', '>=', fromDate], ['posting_date', '<=', toDate]],
        order_by: 'posting_date desc, name asc',
        limit_start: page * BOOKED_PAGE_SIZE,
        limit_page_length: BOOKED_PAGE_SIZE,
      });
      for (const r of rows) {
        if (typeof r.posting_date === 'string' && (oldest === null || r.posting_date < oldest)) oldest = r.posting_date;
        if (r.company !== company || (r.docstatus !== 0 && r.docstatus !== 1) || typeof r.posting_date !== 'string') continue;
        entries.push({ doctype: src.doctype, name: r.name, postingDate: r.posting_date, docstatus: r.docstatus, ...src.map(r) });
      }
      if (rows.length < BOOKED_PAGE_SIZE) break;
      if (page === BOOKED_MAX_PAGES - 1 && oldest !== null && (checkedFrom === null || oldest > checkedFrom)) checkedFrom = oldest;
    }
  }
  return { entries, checkedFrom };
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
