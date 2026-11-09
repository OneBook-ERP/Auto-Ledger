// Test-only fake of InboxErp: every call is a jest mock with a harmless default.
import type { InboxErp } from './erp';

const minor = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? Math.round(Number(v) * 100) : null);
const text = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

/** The DraftSummary the real ERP read would give for a stored document body (test helper). */
export function summaryOf(doctype: string, name: string, b: Record<string, unknown>): Awaited<ReturnType<InboxErp['getDraftSummary']>> {
  return {
    doctype, name, docstatus: 0, company: text(b.company), paymentType: text(b.payment_type), paidFrom: text(b.paid_from), paidTo: text(b.paid_to),
    paidAmountMinor: minor(b.paid_amount), partyType: text(b.party_type), party: text(b.party), totalDebitMinor: minor(b.total_debit), accounts: [],
  };
}

export function fakeInboxErp() {
  let n = 0;
  return {
    findDraftsByUtr: jest.fn<ReturnType<InboxErp['findDraftsByUtr']>, Parameters<InboxErp['findDraftsByUtr']>>(async () => []),
    getDraftSummary: jest.fn<ReturnType<InboxErp['getDraftSummary']>, Parameters<InboxErp['getDraftSummary']>>(async (doctype, name) => summaryOf(doctype, name, {})),
    createDraft: jest.fn<ReturnType<InboxErp['createDraft']>, Parameters<InboxErp['createDraft']>>(async () => ({ name: `PE-${++n}` })),
    deleteDraft: jest.fn<ReturnType<InboxErp['deleteDraft']>, Parameters<InboxErp['deleteDraft']>>(async () => undefined),
    searchParties: jest.fn<ReturnType<InboxErp['searchParties']>, Parameters<InboxErp['searchParties']>>(async () => []),
    getDocStatuses: jest.fn<ReturnType<InboxErp['getDocStatuses']>, Parameters<InboxErp['getDocStatuses']>>(async () => ({})),
    createParty: jest.fn<ReturnType<InboxErp['createParty']>, Parameters<InboxErp['createParty']>>(async (doctype, f) => ({
      doctype, name: String(f.customer_name ?? f.supplier_name ?? f.first_name ?? 'P'),
    })),
    checkSession: jest.fn<ReturnType<InboxErp['checkSession']>, []>(async () => false),
    getRequiredFields: jest.fn<ReturnType<InboxErp['getRequiredFields']>, Parameters<InboxErp['getRequiredFields']>>(async () => []),
    listOpenInvoices: jest.fn<ReturnType<InboxErp['listOpenInvoices']>, Parameters<InboxErp['listOpenInvoices']>>(async () => []),
    listLedgerAccounts: jest.fn<ReturnType<InboxErp['listLedgerAccounts']>, Parameters<InboxErp['listLedgerAccounts']>>(async () => []),
    listBankAccounts: jest.fn<ReturnType<InboxErp['listBankAccounts']>, Parameters<InboxErp['listBankAccounts']>>(async () => []),
  } satisfies InboxErp;
}
export type FakeInboxErp = ReturnType<typeof fakeInboxErp>;
