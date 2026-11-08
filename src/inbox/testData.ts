// Test-only builders: realistic PendingTxns from the redacted IDFC fixtures, plus the pilot's account mappings.
import fixtures from '../../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from '../core/parser';
import type { AccountMapping, PendingTxn } from '../core/types';

type Fixture = { id: string; sender: string; body: string; receivedAt: number };

export function txnFrom(id: string, over: Partial<PendingTxn> = {}): PendingTxn {
  const f = (fixtures as Fixture[]).find((x) => x.id === id);
  if (!f) throw new Error(`no fixture ${id}`);
  const r = parseSms(f.sender, f.body, f.receivedAt, bundledTemplates);
  if (!r.ok) throw new Error(`fixture ${id} does not parse`);
  return { ...r.txn, id: `t_${r.txn.rawHash}`, state: 'new', createdDocs: [], error: null, mergedCount: 1, ...over };
}

export const BANK: AccountMapping = {
  bankAccount: 'IDFC First - ZP', glAccount: 'IDFC First - ZP', kind: 'bank',
  senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Wire Transfer',
};
export const CARD: AccountMapping = {
  bankAccount: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', kind: 'card',
  senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Credit Card',
};
export const BANK2: AccountMapping = {
  bankAccount: 'IDFC Savings - ZP', glAccount: 'IDFC Savings - ZP', kind: 'bank',
  senderIds: ['IDFCFB'], last4: ['1111'], modeOfPayment: 'Wire Transfer',
};

/** 2026-11-08 12:00 IST. */
export const NOW = Date.UTC(2026, 10, 8, 6, 30);
