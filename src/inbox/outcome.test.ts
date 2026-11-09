import { PlanError } from '../core/plan';
import type { ActionPlan } from '../core/types';
import { ErpNetworkError, ErpValidationError } from '../erp/client';
import { OFFLINE_MESSAGE, erpDocUrl, readableFailure, erpNewDocUrl, failedDoctype, outcomeOf, planErrorMessage } from './outcome';

const plan: ActionPlan = {
  steps: [
    { kind: 'create_party', doctype: 'Employee', body: { first_name: 'Ravi' } },
    { kind: 'create_doc', doctype: 'Payment Entry', body: { reference_no: 'X' } },
  ],
  summary: [], needsInrAmount: false,
};

describe('planErrorMessage', () => {
  it('date out of range has the agreed wording', () => {
    expect(planErrorMessage(new PlanError('date_out_of_range'))).toBe('This transaction is dated outside the usual range. Check the date in ERPNext.');
  });
  it('over-allocation wording fits invoices and orders alike', () => {
    expect(planErrorMessage(new PlanError('over_allocated'))).toBe('The amounts add up to more than this transaction. Lower an amount or remove an item.');
  });
  it.each(['bad_direction', 'over_allocated', 'mixed_invoices', 'no_invoices', 'same_account', 'missing_account', 'missing_choice', 'missing_drawings', 'missing_company', 'missing_amount', 'bad_amount', 'bad_date', 'something_new'])(
    '%s has a plain message with a fix hint', (c) => {
      const m = planErrorMessage(new PlanError(c));
      expect(m.length).toBeGreaterThan(20);
      expect(m).not.toContain('_');
    });
  it('non-plan errors get a generic message', () => {
    expect(planErrorMessage(new Error('boom'))).toBe('This answer could not be prepared. Go back and check it.');
  });
});

describe('outcomeOf', () => {
  it('created', () => {
    expect(outcomeOf({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-1' }] }, null, plan)).toEqual({ kind: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-1' }] });
  });
  it('needs_login', () => expect(outcomeOf({ status: 'needs_login' }, null, plan)).toEqual({ kind: 'login' }));
  it('retryable failure: saved, sent later', () => {
    expect(outcomeOf({ status: 'failed', retryable: true, error: new ErpNetworkError('x') }, null, plan)).toEqual({ kind: 'offline', message: OFFLINE_MESSAGE });
    expect(OFFLINE_MESSAGE).toBe('No connection. Your answer is saved and will be sent when you are back online.');
  });
  it('missing fields: the runner message, the field list and the document type', () => {
    const readable = 'Could not create the new Employee. ERPNext needs these fields: Gender. Fill them in ERPNext, or complete this entry in ERPNext.';
    const o = outcomeOf({ status: 'failed', retryable: false, error: new ErpValidationError('Value missing', 417, ['Gender']) }, readable, plan);
    expect(o).toEqual({ kind: 'error', message: readable, missingFields: ['Gender'], doctype: 'Employee', closedPeriod: false });
  });
  it('no readable message: falls back to the error text and the main document type', () => {
    const o = outcomeOf({ status: 'failed', retryable: false, error: new ErpValidationError('Already processed', 0) }, null, plan);
    expect(o).toEqual({ kind: 'error', message: 'Already processed', missingFields: [], doctype: 'Payment Entry', closedPeriod: false });
  });
  it('closed period is flagged', () => {
    const o = outcomeOf({ status: 'failed', retryable: false, error: new ErpValidationError('closed', 417, undefined, true) }, null, plan);
    expect(o.kind === 'error' && o.closedPeriod).toBe(true);
  });
});

describe('failedDoctype', () => {
  it('reads the step the runner names, else the main document', () => {
    expect(failedDoctype('Could not create the Payment Entry. x', plan)).toBe('Payment Entry');
    expect(failedDoctype('Could not create the new Employee. x', plan)).toBe('Employee');
    expect(failedDoctype('other', plan)).toBe('Payment Entry');
    expect(failedDoctype('other', { steps: [], summary: [], needsInrAmount: false })).toBeNull();
  });
});

describe('ERPNext links', () => {
  it('slug is the lower-cased doctype with hyphens; the name is one encoded segment', () => {
    expect(erpDocUrl('https://x.example', 'Payment Entry', 'ACC-PAY-2026-00041')).toBe('https://x.example/app/payment-entry/ACC-PAY-2026-00041');
    expect(erpDocUrl('https://x.example', 'Journal Entry', 'JV/1 #2')).toBe('https://x.example/app/journal-entry/JV%2F1%20%232');
    expect(erpNewDocUrl('https://x.example', 'Employee')).toBe('https://x.example/app/employee/new');
  });
});

describe('readableFailure', () => {
  it('uses the runner note when it describes this error (also when identical to the previous one)', () => {
    const note = 'Could not create the Payment Entry. ERPNext needs these fields: Gender. Fill them in ERPNext, or complete this entry in ERPNext.';
    expect(readableFailure(new ErpValidationError('Value missing', 417, ['Gender']), note)).toBe(note);
    const plain = 'Could not create the Payment Entry. Party is disabled. The draft X was not removed.';
    expect(readableFailure(new ErpValidationError('Party is disabled', 417), plain)).toBe(plain);
    expect(readableFailure(new ErpValidationError('closed', 417, undefined, true), 'Could not create the Payment Entry. The accounting period is closed for this date.')).toContain('closed');
  });
  it('ignores a stale note from a different failure', () => {
    expect(readableFailure(new ErpValidationError('Already processed', 0), 'Could not create the Payment Entry. ERPNext needs these fields: Gender.')).toBeNull();
    expect(readableFailure(new ErpValidationError('x', 417, ['Gender']), 'Could not create the Payment Entry. Party is disabled.')).toBeNull();
    expect(readableFailure(new ErpValidationError('x', 417), null)).toBeNull();
    expect(readableFailure(new ErpValidationError('', 417), 'Could not create the Payment Entry. Party is disabled.')).toBeNull();
    expect(readableFailure(new ErpValidationError('  ', 417), 'Could not create the Payment Entry. Party is disabled.')).toBeNull();
  });
});
