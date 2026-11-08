// The subset of ERPNext document operations the outbox runner needs, as an injectable interface so the
// runner can be tested against a fake. makeErpOps binds it to a real client (used by the pipeline).
import type { PartyRef } from '../core/types';
import { ErpValidationError, type ErpClient } from '../erp/client';
import { createDraft, createParty, deleteDraft, findDraftsByUtr, getDocStatuses, getDraftSummary, searchParties, type DraftSummary, type UtrHit } from '../erp/docs';

export type { DraftSummary, UtrHit } from '../erp/docs';

export interface ErpOps {
  /**
   * Every non-cancelled Payment Entry (reference_no) and Journal Entry (cheque_no) carrying `reference`
   * (docstatus 0 or 1), Payment Entries first, each oldest first; [] when none.
   */
  findDraftsByUtr(reference: string): Promise<UtrHit[]>;
  /** One document's compared fields (payment type, accounts, amount, party); throws like any read. */
  getDraftSummary(doctype: string, name: string): Promise<DraftSummary>;
  /** Creates a DRAFT (docstatus 0) and never submits. */
  createDraft(doctype: string, body: Record<string, unknown>): Promise<{ name: string }>;
  /** Throws NotDraftError when the document is no longer a draft. */
  deleteDraft(doctype: string, name: string): Promise<void>;
  /** `name` is the document id (may be a naming series); `displayName` is customer/supplier/employee name. */
  searchParties(doctype: PartyRef['doctype'], q: string, exact?: boolean): Promise<(PartyRef & { displayName: string })[]>;
  /** Keyed `${doctype}:${name}`; a missing key means the document is gone (or not visible). */
  getDocStatuses(refs: { doctype: string; name: string }[]): Promise<Record<string, number>>;
  createParty(doctype: PartyRef['doctype'], fields: Record<string, unknown>): Promise<PartyRef>;
}

export function makeErpOps(client: ErpClient): ErpOps {
  return {
    findDraftsByUtr: (reference) => findDraftsByUtr(client, reference),
    getDraftSummary: (doctype, name) => getDraftSummary(client, doctype, name),
    createDraft: async (doctype, body) => {
      if (doctype !== 'Payment Entry' && doctype !== 'Journal Entry') {
        throw new ErpValidationError(`AutoLedger cannot create a ${doctype}.`, 0);
      }
      return createDraft(client, doctype, body);
    },
    deleteDraft: (doctype, name) => deleteDraft(client, doctype, name),
    searchParties: (doctype, q, exact) => searchParties(client, doctype, q, exact),
    getDocStatuses: (refs) => getDocStatuses(client, refs),
    createParty: (doctype, fields) => createParty(client, doctype, fields),
  };
}
