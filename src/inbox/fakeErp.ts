// Test-only fake of InboxErp: every call is a jest mock with a harmless default.
import type { InboxErp } from './erp';

export function fakeInboxErp() {
  let n = 0;
  return {
    findDraftByUtr: jest.fn<ReturnType<InboxErp['findDraftByUtr']>, Parameters<InboxErp['findDraftByUtr']>>(async () => null),
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
  } satisfies InboxErp;
}
export type FakeInboxErp = ReturnType<typeof fakeInboxErp>;
