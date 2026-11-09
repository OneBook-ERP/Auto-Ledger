import {
  canPutBack, canUndo, confirmText, docUrl, filterActivity, groupByRecency, removalPlan, sortActivity, statusOf, totalsOf, KEEP_ADOPTED_MESSAGE, UNDO_CONFIRM_MESSAGE,
} from './activityModel';
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

describe('Activity filter, totals, grouping and sort', () => {
  const TODAY = '2026-11-09';
  const mk = (id: string, over: Partial<PendingTxn> = {}): PendingTxn => ({
    id, mergedCount: 1, state: 'created', createdDocs: [], error: null,
    kind: 'ca_credit', direction: 'in', amountMinor: 100, currency: 'INR',
    occurredOn: '2026-11-05', occurredTime: null, accountType: 'bank', accountLast4: '3455',
    counterparty: null, utr: null, merchant: null, balanceMinor: null,
    sender: 'AX-IDFCFB', receivedAt: Number(id.replace(/\D/g, '') || 0), rawHash: `h${id}`, ...over,
  });
  const ids = (l: PendingTxn[]) => l.map((x) => x.id);
  const f = (over: Partial<Parameters<typeof filterActivity>[1]> = {}) => ({ query: '', period: 'all' as const, ...over });

  it('period boundaries: this month, last month, this financial year (1 April)', () => {
    const l = [
      mk('1', { occurredOn: '2026-11-01' }), mk('2', { occurredOn: '2026-10-31' }), mk('3', { occurredOn: '2026-10-01' }),
      mk('4', { occurredOn: '2026-09-30' }), mk('5', { occurredOn: '2026-04-01' }), mk('6', { occurredOn: '2026-03-31' }),
    ];
    expect(ids(filterActivity(l, f({ period: 'this_month' }), TODAY))).toEqual(['1']);
    expect(ids(filterActivity(l, f({ period: 'last_month' }), TODAY))).toEqual(['2', '3']);
    expect(ids(filterActivity(l, f({ period: 'this_fy' }), TODAY))).toEqual(['1', '2', '3', '4', '5']);
    expect(ids(filterActivity(l, f({ period: 'all' }), TODAY))).toHaveLength(6);
  });
  it('last month wraps over the year end; FY before April starts last April', () => {
    const l = [mk('1', { occurredOn: '2025-12-31' }), mk('2', { occurredOn: '2026-01-02' }), mk('3', { occurredOn: '2025-03-31' }), mk('4', { occurredOn: '2025-04-01' })];
    expect(ids(filterActivity(l, f({ period: 'last_month' }), '2026-01-15'))).toEqual(['1']);
    expect(ids(filterActivity(l, f({ period: 'this_fy' }), '2026-02-10'))).toEqual(['1', '2', '4']);
  });
  it('query is case-insensitive, trimmed, and spaces-only matches everything', () => {
    const l = [mk('1', { counterparty: 'Fuel Station' }), mk('2', { merchant: 'Amazon' }), mk('3', { counterparty: 'Rent' })];
    expect(ids(filterActivity(l, f({ query: '  FUEL ' }), TODAY))).toEqual(['1']);
    expect(ids(filterActivity(l, f({ query: 'amaz' }), TODAY))).toEqual(['2']);
    expect(ids(filterActivity(l, f({ query: '   ' }), TODAY))).toHaveLength(3);
  });
  it('regex characters in the query are plain text', () => {
    const l = [mk('1', { merchant: 'Shop (Pvt) Ltd' }), mk('2', { merchant: 'Star*Mart' }), mk('3', { merchant: 'Other' })];
    expect(() => filterActivity(l, f({ query: '(' }), TODAY)).not.toThrow();
    expect(ids(filterActivity(l, f({ query: '(' }), TODAY))).toEqual(['1']);
    expect(ids(filterActivity(l, f({ query: '*' }), TODAY))).toEqual(['2']);
    expect(ids(filterActivity(l, f({ query: '.*' }), TODAY))).toEqual([]);
  });
  it('filters by direction and account', () => {
    const l = [mk('1'), mk('2', { direction: 'out' }), mk('3', { accountLast4: '9999' })];
    expect(ids(filterActivity(l, f({ direction: 'out' }), TODAY))).toEqual(['2']);
    expect(ids(filterActivity(l, f({ accountLast4: '9999' }), TODAY))).toEqual(['3']);
  });
  it('totals are exact integer paise; foreign currency is counted apart', () => {
    const l = [
      mk('1', { amountMinor: 10 }), mk('2', { amountMinor: 20 }), mk('3', { direction: 'out', amountMinor: 5 }),
      mk('4', { currency: 'USD', amountMinor: 99999 }),
    ];
    expect(totalsOf(l)).toEqual({ inMinor: 30, outMinor: 5, netMinor: 25, foreignCount: 1 });
    expect(totalsOf([])).toEqual({ inMinor: 0, outMinor: 0, netMinor: 0, foreignCount: 0 });
  });
  it('groupByRecency omits empty groups', () => {
    const l = [
      mk('1', { occurredOn: '2026-11-09' }), mk('2', { occurredOn: '2026-11-08' }), mk('3', { occurredOn: '2026-11-05' }), mk('4', { occurredOn: '2026-10-01' }),
    ];
    const g = groupByRecency(l, TODAY);
    expect(g.map((x) => x.title)).toEqual(['Today', 'Yesterday', 'This week', 'Earlier']);
    expect(g.map((x) => ids(x.rows))).toEqual([['1'], ['2'], ['3'], ['4']]);
    expect(groupByRecency([l[3]], TODAY).map((x) => x.title)).toEqual(['Earlier']);
    expect(groupByRecency([], TODAY)).toEqual([]);
  });
  it('sorts by newest, oldest, amount and name without mutating the input', () => {
    const l = [
      mk('1', { occurredOn: '2026-11-01', amountMinor: 500, counterparty: 'beta' }),
      mk('2', { occurredOn: '2026-11-03', amountMinor: 100, counterparty: 'Alpha' }),
      mk('3', { occurredOn: '2026-11-02', amountMinor: 900, merchant: 'Gamma' }),
    ];
    const copy = [...l];
    expect(ids(sortActivity(l, 'newest'))).toEqual(['2', '3', '1']);
    expect(ids(sortActivity(l, 'oldest'))).toEqual(['1', '3', '2']);
    expect(ids(sortActivity(l, 'amount_high'))).toEqual(['3', '1', '2']);
    expect(ids(sortActivity(l, 'amount_low'))).toEqual(['2', '1', '3']);
    expect(ids(sortActivity(l, 'name_az'))).toEqual(['2', '1', '3']);
    expect(l).toEqual(copy);
  });

  it('filters by status: waiting (drafts), submitted, ignored', () => {
    const l = [mk('1'), mk('2', { state: 'submitted' }), mk('3', { state: 'ignored' })];
    expect(ids(filterActivity(l, f({ status: 'waiting' }), TODAY))).toEqual(['1']);
    expect(ids(filterActivity(l, f({ status: 'submitted' }), TODAY))).toEqual(['2']);
    expect(ids(filterActivity(l, f({ status: 'ignored' }), TODAY))).toEqual(['3']);
    expect(ids(filterActivity(l, f(), TODAY))).toHaveLength(3);
  });
  it('search finds the sender when it is the visible title', () => {
    const l = [mk('1', { sender: 'AX-IDFCFB' }), mk('2', { counterparty: 'Rent', sender: 'XX-OTHER' })];
    expect(ids(filterActivity(l, f({ query: 'idfcfb' }), TODAY))).toEqual(['1']);
  });
  it('totals leave out ignored items and drafts cancelled or missing in ERPNext', () => {
    const d = (docstatus: number) => [{ doctype: 'Payment Entry', name: 'X', docstatus }];
    const l = [
      mk('1', { amountMinor: 10, createdDocs: d(0) }), mk('2', { amountMinor: 20, createdDocs: d(1), state: 'submitted' }),
      mk('3', { amountMinor: 1000, state: 'ignored' }), mk('4', { amountMinor: 2000, createdDocs: d(2) }), mk('5', { amountMinor: 4000, createdDocs: d(-1) }),
    ];
    expect(totalsOf(l)).toEqual({ inMinor: 30, outMinor: 0, netMinor: 30, foreignCount: 0 });
  });
});

