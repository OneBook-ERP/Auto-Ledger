// The ERPNext calls the Inbox flow needs, as one injectable interface (tests pass a fake).
import type { OpenInvoice, PartyRef } from '../core/types';
import { ErpAuthError, type ErpClient } from '../erp/client';
import { getRequiredFields, listBankAccounts, listLedgerAccounts, listOpenInvoices, listOpenSalesOrders, type OpenOrder } from '../erp/docs';
import { makeErpOps, type ErpOps } from '../outbox/erpOps';
import type { RequiredField } from './flow';

export interface InboxErp extends ErpOps {
  /** True when the saved credentials still work (cheap authenticated call). */
  checkSession(): Promise<boolean>;
  getRequiredFields(doctype: PartyRef['doctype']): Promise<RequiredField[]>;
  listOpenInvoices(partyType: 'Customer' | 'Supplier', party: string): Promise<OpenInvoice[]>;
  /** A customer's open Sales Orders that can still take an advance, oldest first. */
  listOpenSalesOrders(customer: string): Promise<OpenOrder[]>;
  listLedgerAccounts(company: string, f: { rootType: 'Expense' | 'Income' }): Promise<{ name: string; accountType: string | null }[]>;
  /** The company's ERPNext Bank Accounts (sources of an incoming own-account transfer). */
  listBankAccounts(company: string): Promise<{ name: string; glAccount: string; isCompanyAccount: boolean }[]>;
}

export function makeInboxErp(client: ErpClient): InboxErp {
  return {
    ...makeErpOps(client),
    async checkSession() {
      try {
        await client.get('/api/method/frappe.auth.get_logged_user');
        return true;
      } catch (e) {
        if (e instanceof ErpAuthError) return false;
        throw e;
      }
    },
    getRequiredFields: (doctype) => getRequiredFields(client, doctype),
    listOpenInvoices: (partyType, party) => listOpenInvoices(client, partyType, party),
    listOpenSalesOrders: (customer) => listOpenSalesOrders(client, customer),
    listLedgerAccounts: (company, f) => listLedgerAccounts(client, company, f),
    listBankAccounts: (company) => listBankAccounts(client, company),
  };
}
