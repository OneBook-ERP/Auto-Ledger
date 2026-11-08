import { canPutBack, canUndo, confirmText, docUrl, removalPlan, statusOf, KEEP_ADOPTED_MESSAGE, UNDO_CONFIRM_MESSAGE } from './activityModel';
import type { PendingTxn } from '../core/types';

const t = (docstatuses: number[], state: PendingTxn['state'] = 'created') =>
  ({ state, createdDocs: docstatuses.map((d, i) => ({ doctype: 'Payment Entry', name: `PE-${i}`, docstatus: d })) }) as PendingTxn;

it('docUrl slugs the doctype and encodes the name', () => {
  expect(docUrl('https://x.test/', { doctype: 'Journal Entry', name: 'ACC JV/1' })).toBe('https://x.test/app/journal-entry/ACC%20JV%2F1');
});
it('status text per document state (never colour alone)', () => {
  expect(statusOf(t([0])).label).toBe('Draft');
  expect(statusOf(t([0, 2])).label).toBe('Cancelled in ERPNext');
  expect(statusOf(t([0, -1])).label).toBe('Not found in ERPNext');
  expect(statusOf(t([1], 'submitted')).label).toBe('Submitted');
});
it('Undo only for all-draft; put back only for cancelled/missing without a submitted doc', () => {
  expect(canUndo(t([0, 0]))).toBe(true);
  expect(canUndo(t([0, 1]))).toBe(false);
  expect(canUndo(t([]))).toBe(false);
  expect(canPutBack(t([2]))).toBe(true);
  expect(canPutBack(t([-1, 0]))).toBe(true);
  expect(canPutBack(t([2, 1]))).toBe(false);
  expect(canPutBack(t([0]))).toBe(false);
});

it('a mix of submitted and cancelled is "Partly submitted" with no put-back', () => {
  expect(statusOf(t([1, 2])).label).toBe('Partly submitted');
  expect(statusOf(t([1, -1])).label).toBe('Partly submitted');
  expect(canPutBack(t([1, 2]))).toBe(false);
});
it('removalPlan separates deletable drafts from adopted and shared ones, and the dialog says so', () => {
  const mine = { ...t([0, 0]), id: 'a', createdDocs: [{ doctype: 'Payment Entry', name: 'P1', docstatus: 0 }, { doctype: 'Payment Entry', name: 'P2', docstatus: 0, adopted: true }, { doctype: 'Payment Entry', name: 'P3', docstatus: 0 }] } as PendingTxn;
  const other = { ...t([0]), id: 'b', createdDocs: [{ doctype: 'Payment Entry', name: 'P3', docstatus: 0 }] } as PendingTxn;
  const plan = removalPlan(mine, [mine, other]);
  expect(plan.remove.map((d) => d.name)).toEqual(['P1']);
  expect(plan.keep.map((d) => d.name)).toEqual(['P2', 'P3']);
  expect(confirmText(plan)!.message).toContain(KEEP_ADOPTED_MESSAGE);
  expect(confirmText({ remove: plan.remove, keep: [] })!.message).toBe(UNDO_CONFIRM_MESSAGE);
  expect(confirmText({ remove: [], keep: [plan.keep[0]] })!.message).toBe(KEEP_ADOPTED_MESSAGE);
  expect(confirmText({ remove: [], keep: [] })).toBeNull();
});
