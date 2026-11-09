import type { PendingTxn } from '../core/types';
import { activeInboxFilterCount, filterPending, type InboxFilter } from './inboxFilter';
import { txnFrom } from './testData';

const F: InboxFilter = { query: '', period: 'all' };
const mk = (id: string, over: Partial<PendingTxn>) => txnFrom('idfc-006', { id, ...over });

describe('filterPending', () => {
  const a = mk('a', { counterparty: 'Fuel Station', merchant: null, sender: 'IDFCFB', occurredOn: '2026-11-05', direction: 'out', accountLast4: '6507' });
  const b = mk('b', { counterparty: null, merchant: 'GOOGLESERVIS', sender: 'IDFCFB', occurredOn: '2026-10-20', direction: 'out', accountLast4: '3455', kind: 'card_spend' });
  const c = mk('c', { counterparty: 'ram@okaxis', merchant: null, sender: 'AX-HDFCBK', occurredOn: '2026-03-31', direction: 'in', accountLast4: '6507' });
  const all = [a, b, c];
  const ids = (xs: PendingTxn[]) => xs.map((x) => x.id);

  it('matches merchant, counterparty and sender, case-insensitive and trimmed', () => {
    expect(ids(filterPending(all, { ...F, query: '  FUEL ' }, '2026-11-09'))).toEqual(['a']);
    expect(ids(filterPending(all, { ...F, query: 'googleservis' }, '2026-11-09'))).toEqual(['b']);
    expect(ids(filterPending(all, { ...F, query: 'hdfcbk' }, '2026-11-09'))).toEqual(['c']);
  });
  it('treats regex characters and blank input as plain text', () => {
    expect(() => filterPending(all, { ...F, query: '(' }, '2026-11-09')).not.toThrow();
    expect(filterPending(all, { ...F, query: '(' }, '2026-11-09')).toEqual([]);
    expect(filterPending(all, { ...F, query: '*' }, '2026-11-09')).toEqual([]);
    expect(ids(filterPending(all, { ...F, query: '   ' }, '2026-11-09'))).toEqual(['a', 'b', 'c']);
  });
  it('period boundaries: month and financial year from 1 April', () => {
    expect(ids(filterPending(all, { ...F, period: 'this_month' }, '2026-11-09'))).toEqual(['a']);
    expect(ids(filterPending(all, { ...F, period: 'last_month' }, '2026-11-09'))).toEqual(['b']);
    expect(ids(filterPending(all, { ...F, period: 'this_fy' }, '2026-11-09'))).toEqual(['a', 'b']);
    expect(ids(filterPending(all, { ...F, period: 'this_fy' }, '2026-03-31'))).toEqual(['c']);
  });
  it('direction, account and kind combine with AND', () => {
    expect(ids(filterPending(all, { ...F, direction: 'out' }, '2026-11-09'))).toEqual(['a', 'b']);
    expect(ids(filterPending(all, { ...F, direction: 'out', accountLast4: '6507' }, '2026-11-09'))).toEqual(['a']);
    expect(ids(filterPending(all, { ...F, kind: 'card' }, '2026-11-09'))).toEqual(['b']);
    expect(ids(filterPending(all, { ...F, kind: 'upi' }, '2026-11-09'))).toEqual(['c']);
    expect(ids(filterPending(all, { ...F, kind: 'bank' }, '2026-11-09'))).toEqual(['a']);
    expect(filterPending(all, { ...F, kind: 'card', direction: 'in' }, '2026-11-09')).toEqual([]);
  });
});

describe('activeInboxFilterCount', () => {
  it('counts only non-default sheet settings', () => {
    expect(activeInboxFilterCount(F)).toBe(0);
    expect(activeInboxFilterCount({ query: 'x', period: 'this_month' })).toBe(0);
    expect(activeInboxFilterCount({ ...F, direction: 'in', accountLast4: '1', kind: 'upi' })).toBe(3);
  });
});
