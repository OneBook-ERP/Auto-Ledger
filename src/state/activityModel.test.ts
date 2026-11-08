import { canPutBack, canUndo, docUrl, statusOf } from './activityModel';
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
