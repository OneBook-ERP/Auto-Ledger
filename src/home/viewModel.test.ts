import type { AccountMapping, PendingTxn } from '../core/types';
import { buildHomeModel, parseHomeCache, relativeTime, serializeHomeCache, type HomeInputs } from './viewModel';

const acc = (n: string, kind: 'bank' | 'card', last4: string): AccountMapping => ({ bankAccount: n, glAccount: `${n} - GL`, kind, senderIds: [], last4: [last4], modeOfPayment: 'Bank' });
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
    expect(m.receivableText).toBe('₹11,21,725');
    expect(m.payableText).toBe('₹2,50,526');
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
    expect(m.receivableText).toBe('—');
    expect(m.payableText).toBe('—');
    expect(JSON.stringify(m)).not.toContain('NaN');
  });
  it('no figures at all: everything is a dash', () => {
    const m = buildHomeModel(inputs({ figures: null, figuresAt: null }));
    expect(m.bank.accounts[0].text).toBe('—');
    expect(m.receivableText).toBe('—');
    expect(m.hasFigures).toBe(false);
  });
  it('drafts: count and rupee total of INR created txns, foreign currency counted with a footnote', () => {
    const m = buildHomeModel(inputs({ pending: [
      txn({ state: 'created', amountMinor: 1000 }), txn({ state: 'created', amountMinor: 2500 }),
      txn({ state: 'created', amountMinor: 900, currency: 'USD' }), txn({ state: 'submitted', amountMinor: 7 }),
    ] }));
    expect(m.drafts).toMatchObject({ count: 3, totalMinor: 3500, totalText: '₹35.00', otherCurrencyCount: 1, footnote: 'plus 1 in other currencies' });
    expect(m.trust.incomplete).toBe(false);
  });
  it('no drafts: no footnote, zero total', () => {
    const m = buildHomeModel(inputs());
    expect(m.drafts).toMatchObject({ count: 0, totalMinor: 0, footnote: null });
  });
  it('unclassified count is txns in state new and drives the trust banner', () => {
    const m = buildHomeModel(inputs({ pending: [txn({}), txn({})] }));
    expect(m.unclassifiedCount).toBe(2);
    expect(m.trust).toMatchObject({ incomplete: true, reasons: ['2 messages need an answer'] });
  });
  it('picks the newest bank txn with a balance of the SAME account for the comparison', () => {
    const m = buildHomeModel(inputs({ pending: [
      txn({ receivedAt: 5, balanceMinor: 111 }), txn({ receivedAt: 9, balanceMinor: 51293276 }),
      txn({ receivedAt: 20, balanceMinor: null }), txn({ receivedAt: 30, balanceMinor: 999, accountLast4: '9999' }),
      txn({ receivedAt: 40, balanceMinor: 888, accountType: 'card' }),
    ] }));
    expect(m.smsBalanceMinor).toBe(51293276);
    expect(m.trust.mismatch).toBe(false);
    const m2 = buildHomeModel(inputs({ pending: [txn({ receivedAt: 9, balanceMinor: 50000000 })] }));
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
