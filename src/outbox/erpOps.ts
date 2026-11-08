// The subset of ERPNext document operations the outbox runner needs, as an injectable interface so the
// runner can be tested against a fake. makeErpOps binds it to a real client (used by the pipeline).
import type { PartyRef } from '../core/types';
import { ErpValidationError, type ErpClient } from '../erp/client';
import { createDraft, createParty, deleteDraft, findDraftByUtr, getDocStatuses, searchParties } from '../erp/docs';

export interface ErpOps {
  /** Non-cancelled Payment Entry (reference_no) or Journal Entry (cheque_no) carrying `reference`; docstatus 0 or 1. */
  findDraftByUtr(reference: string): Promise<{ doctype: string; name: string; docstatus: number } | null>;
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
    findDraftByUtr: (reference) => findDraftByUtr(client, reference),
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
