import type { AccountMapping, PendingTxn } from '../core/types';
import { buildHomeModel, cycleCountsAsSynced, wholeText, parseHomeCache, relativeTime, serializeHomeCache, type HomeInputs } from './viewModel';

const acc = (n: string, kind: 'bank' | 'card', last4: string): AccountMapping => ({ bankAccount: n, glAccount: `${n} - GL`, kind, senderIds: ['X'], last4: [last4], modeOfPayment: 'Bank' });
const txn = (o: Partial<PendingTxn>): PendingTxn => ({
  id: Math.random().toString(), mergedCount: 1, state: 'new', createdDocs: [], error: null, kind: 'ca_credit', direction: 'in', amountMinor: 100,
  currency: 'INR', occurredOn: '2026-11-01', occurredTime: null, accountType: 'bank', accountLast4: '6507', counterparty: null, utr: null, merchant: null,
  balanceMinor: null, sender: 'X', receivedAt: 1, rawHash: Math.random().toString(), ...o,
});
const NOW = 10_000_000_000;
const inputs = (o: Partial<HomeInputs> = {}): HomeInputs => ({
  mappings: [acc('IDFC', 'bank', '6507')], pending: [], figures: { balances: { 'IDFC - GL': 51293276 }, receivableMinor: 112172500, payableMinor: 25052600 },
  figuresAt: NOW, figuresStale: false, lastSyncedAt: NOW - 120_000, now: NOW, ...o,
});

describe('buildHomeModel', () => {
  it('shows one bank account balance without a total line', () => {
    const m = buildHomeModel(inputs());
    expect(m.bank.accounts).toEqual([expect.objectContaining({ name: 'IDFC', text: '₹5,12,932.76' })]);
    expect(m.bank.total).toBeNull();
    expect(m.receivable).toEqual({ label: 'To receive', text: '₹11,21,725' });
    expect(m.payable).toEqual({ label: 'To pay', text: '₹2,50,526' });
  });
  it('several bank accounts give a total plus per-account lines; cards are not shown', () => {
    const m = buildHomeModel(inputs({
      mappings: [acc('A', 'bank', '1111'), acc('B', 'bank', '2222'), acc('C', 'card', '3333')],
      figures: { balances: { 'A - GL': 1000, 'B - GL': 250, 'C - GL': -99999 }, receivableMinor: 0, payableMinor: 0 },
    }));
    expect(m.bank.accounts.map((a) => a.name)).toEqual(['A', 'B']);
    expect(m.bank.total).toEqual({ minor: 1250, text: '₹12.50' });
  });
  it('unknown balance is an em dash and the total is unknown too', () => {
    const m = buildHomeModel(inputs({ mappings: [acc('A', 'bank', '1'), acc('B', 'bank', '2')], figures: { balances: { 'A - GL': 5 }, receivableMinor: null, payableMinor: null } }));
    expect(m.bank.accounts[1].text).toBe('—');
    expect(m.bank.total?.text).toBe('—');
    expect(m.receivable.text).toBe('—');
    expect(m.payable.text).toBe('—');
    expect(JSON.stringify(m)).not.toContain('NaN');
  });
  it('no figures at all: everything is a dash', () => {
    const m = buildHomeModel(inputs({ figures: null, figuresAt: null }));
    expect(m.bank.accounts[0].text).toBe('—');
    expect(m.receivable.text).toBe('—');
    expect(m.hasFigures).toBe(false);
  });
  it('drafts: count and rupee total of INR created txns, foreign currency counted with a footnote', () => {
    const m = buildHomeModel(inputs({ pending: [
      txn({ state: 'created', amountMinor: 1000 }), txn({ state: 'created', amountMinor: 2500 }),
      txn({ state: 'created', amountMinor: 900, currency: 'USD' }), txn({ state: 'submitted', amountMinor: 7 }),
    ] }));
    expect(m.drafts).toMatchObject({ count: 3, inMinor: 3500, inCount: 2, outCount: 0, summaryText: '₹35.00 in', otherCurrencyCount: 1, footnote: 'plus 1 in other currencies' });
    expect(m.trust.incomplete).toBe(false);
  });
  it('no drafts: no footnote, zero total', () => {
    const m = buildHomeModel(inputs());
    expect(m.drafts).toMatchObject({ count: 0, inMinor: 0, outMinor: 0, summaryText: '', footnote: null });
  });
  it('unclassified count is txns in state new and drives the trust banner', () => {
    const m = buildHomeModel(inputs({ pending: [txn({}), txn({})] }));
    expect(m.unclassifiedCount).toBe(2);
    expect(m.trust).toMatchObject({ incomplete: true, reasons: ['2 messages need an answer'] });
  });
  it('picks the newest bank txn with a balance of the SAME account for the comparison', () => {
    const m = buildHomeModel(inputs({ pending: [
      txn({ state: 'submitted', receivedAt: 5, balanceMinor: 111 }), txn({ state: 'ignored', receivedAt: 9, balanceMinor: 51293276 }),
      txn({ state: 'submitted', receivedAt: 20, balanceMinor: null }), txn({ state: 'submitted', receivedAt: 30, balanceMinor: 999, accountLast4: '9999' }),
      txn({ state: 'submitted', receivedAt: 40, balanceMinor: 888, accountType: 'card' }),
    ] }));
    expect(m.smsBalanceMinor).toBe(51293276);
    expect(m.trust.mismatch).toBe(false);
    const m2 = buildHomeModel(inputs({ pending: [txn({ state: 'submitted', receivedAt: 9, balanceMinor: 50000000 })] }));
    expect(m2.trust.mismatch).toBe(true);
    expect(m2.smsBalanceMinor).toBe(50000000);
  });
  it('stale figures are labelled "as of" with a could-not-refresh note', () => {
    const m = buildHomeModel(inputs({ figuresStale: true, figuresAt: NOW - 3_600_000 }));
    expect(m.asOfLabel).toBe('as of 1 hour ago');
    expect(m.couldNotRefresh).toBe(true);
    const fresh = buildHomeModel(inputs());
    expect(fresh.asOfLabel).toBeNull();
    expect(fresh.couldNotRefresh).toBe(false);
  });
  it('last synced line', () => {
    expect(buildHomeModel(inputs()).lastSyncedText).toBe('Last synced 2 minutes ago');
    expect(buildHomeModel(inputs({ lastSyncedAt: null })).lastSyncedText).toBe('Not synced yet');
  });
});

describe('relativeTime', () => {
  it.each([
    [0, 'just now'], [59_000, 'just now'], [60_000, '1 minute ago'], [120_000, '2 minutes ago'], [3_600_000, '1 hour ago'],
    [7_200_000, '2 hours ago'], [86_400_000, '1 day ago'], [3 * 86_400_000, '3 days ago'], [-5000, 'just now'],
  ])('%d ms -> %s', (d, s) => expect(relativeTime(1_000_000_000, 1_000_000_000 - d)).toBe(s));
});

describe('home cache', () => {
  it('round-trips and rejects garbage and other sites', () => {
    const c = { at: 5, site: 'https://a.example', balances: { x: 1 }, receivableMinor: 2, payableMinor: 3 };
    expect(parseHomeCache(serializeHomeCache(c), 'https://a.example')).toEqual(c);
    expect(parseHomeCache(serializeHomeCache(c), 'https://b.example')).toBeNull();
    expect(parseHomeCache('{nope', 'https://a.example')).toBeNull();
    expect(parseHomeCache(null, 'https://a.example')).toBeNull();
    expect(parseHomeCache(JSON.stringify({ at: 'x', site: 'https://a.example' }), 'https://a.example')).toBeNull();
    expect(parseHomeCache(JSON.stringify({ ...c, balances: { x: 'NaN' } }), 'https://a.example')).toBeNull();
  });
});

describe('drafts in and out', () => {
  const credit = (a: number) => txn({ state: 'created', direction: 'in', amountMinor: a });
  const debit = (a: number) => txn({ state: 'created', direction: 'out', amountMinor: a });
  it('mixed directions are never added together', () => {
    const m = buildHomeModel(inputs({ pending: [credit(10000000), credit(10000000), debit(3046600)] }));
    expect(m.drafts).toMatchObject({ count: 3, inCount: 2, inMinor: 20000000, outCount: 1, outMinor: 3046600, summaryText: '₹2,00,000.00 in · ₹30,466.00 out' });
  });
  it('only credits / only debits omit the empty side', () => {
    expect(buildHomeModel(inputs({ pending: [credit(500)] })).drafts.summaryText).toBe('₹5.00 in');
    expect(buildHomeModel(inputs({ pending: [debit(500)] })).drafts.summaryText).toBe('₹5.00 out');
  });
});

it("'failed' items count as needing an answer", () => {
  const m = buildHomeModel(inputs({ pending: [txn({ state: 'failed' }), txn({ state: 'new' })] }));
  expect(m.unclassifiedCount).toBe(2);
  expect(m.trust.reasons).toEqual(['2 messages need an answer']);
});

describe('sms balance via resolveMapping', () => {
  const one = [acc('IDFC', 'bank', '6507')];
  const settled = (o: Partial<PendingTxn>) => txn({ state: 'submitted', sender: 'X', ...o });
  it('a txn without last4 is used when there is a single bank mapping and the sender matches', () => {
    const m = buildHomeModel(inputs({ mappings: [{ ...one[0], senderIds: ['X'] }], pending: [settled({ accountLast4: null, balanceMinor: 7, receivedAt: 5 })] }));
    expect(m.smsBalanceMinor).toBe(7);
    expect(m.trust.mismatch).toBe(true);
  });
  it('a txn without last4 is not used with two bank mappings', () => {
    const maps = [{ ...acc('A', 'bank', '1'), senderIds: ['X'] }, { ...acc('B', 'bank', '2'), senderIds: ['X'] }];
    const m = buildHomeModel(inputs({ mappings: maps, figures: { balances: { 'A - GL': 1, 'B - GL': 2 }, receivableMinor: 0, payableMinor: 0 }, pending: [settled({ accountLast4: null, balanceMinor: 7 })] }));
    expect(m.smsBalanceMinor).toBeNull();
  });
  it('a sender that does not match the mapping is ignored', () => {
    const m = buildHomeModel(inputs({ mappings: [{ ...one[0], senderIds: ['HDFCBK'] }], pending: [settled({ sender: 'OTHER', balanceMinor: 7 })] }));
    expect(m.smsBalanceMinor).toBeNull();
  });
  it('an account with new or created items skips the comparison', () => {
    const base = [settled({ receivedAt: 1, balanceMinor: 7 })];
    for (const state of ['new', 'created'] as const) {
      const m = buildHomeModel(inputs({ pending: [...base, txn({ state, receivedAt: 2 })] }));
      expect(m.smsBalanceMinor).toBeNull();
      expect(m.trust.mismatch).toBe(false);
    }
  });
  it('the first differing account wins across several accounts', () => {
    const maps = [acc('A', 'bank', '1'), acc('B', 'bank', '2'), acc('C', 'bank', '3')];
    const m = buildHomeModel(inputs({
      mappings: maps,
      figures: { balances: { 'A - GL': 100, 'B - GL': 200, 'C - GL': 300 }, receivableMinor: 0, payableMinor: 0 },
      pending: [settled({ accountLast4: '1', balanceMinor: 100 }), settled({ accountLast4: '2', balanceMinor: 250 }), settled({ accountLast4: '3', balanceMinor: 999 })],
    }));
    expect(m.smsBalanceMinor).toBe(250);
    expect(m.trust.mismatch).toBe(true);
  });
});

describe('tiles', () => {
  it('rounds half away from zero and never shows a tiny amount as zero', () => {
    expect(wholeText(150)).toBe('₹2');
    expect(wholeText(149)).toBe('₹1');
    expect(wholeText(-150)).toBe('-₹2');
    expect(wholeText(49)).toBe('under ₹1');
    expect(wholeText(-49)).toBe('under ₹1');
    expect(wholeText(0)).toBe('₹0');
    expect(wholeText(null)).toBe('—');
  });
  it('negative net of advances is labelled Advances received / paid with the absolute amount', () => {
    const m = buildHomeModel(inputs({ figures: { balances: {}, receivableMinor: -500000, payableMinor: -250000 } }));
    expect(m.receivable).toEqual({ label: 'Advances received', text: '₹5,000' });
    expect(m.payable).toEqual({ label: 'Advances paid', text: '₹2,500' });
  });
});

describe('cycleCountsAsSynced', () => {
  const ok = { failedSteps: [], drain: { ran: 0, stoppedBecause: 'empty' as const } };
  it.each([
    [ok, true], [{ ...ok, drain: { ran: 1, stoppedBecause: 'limit' as const } }, true],
    [{ ...ok, drain: { ran: 0, stoppedBecause: 'retry_later' as const } }, false], [{ ...ok, drain: { ran: 0, stoppedBecause: 'needs_login' as const } }, false],
    [{ ...ok, failedSteps: ['ingest' as const] }, false], [{ ...ok, skipped: 'site_mismatch' }, false], [{ failedSteps: [] }, false], [null, false],
  ])('%j -> %s', (s, want) => expect(cycleCountsAsSynced(s as never)).toBe(want));
});
