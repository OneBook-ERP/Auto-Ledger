import { findSimilar, type BookedEntry } from './similar';
import type { PendingTxn } from './types';

const txn = (over: Partial<PendingTxn> = {}): PendingTxn => ({
  kind: 'card_spend', direction: 'out', amountMinor: 50000, currency: 'INR',
  occurredOn: '2026-11-08', occurredTime: '10:00', accountType: 'card', accountLast4: '1234',
  counterparty: null, utr: null, merchant: 'HP Fuel Station', balanceMinor: null, sender: 'AD-IDFCFB', receivedAt: 1, rawHash: 'abc123',
  id: 't_abc123', mergedCount: 1, state: 'new', createdDocs: [], error: null,
  ...over,
});

const entry = (over: Partial<BookedEntry> = {}): BookedEntry => ({
  doctype: 'Payment Entry', name: 'ACC-PAY-0001', postingDate: '2026-11-08', amountMinor: 50000,
  direction: 'out', party: 'HP Fuel Station', reference: null, docstatus: 0,
  ...over,
});

describe('findSimilar', () => {
  it('same reference is strong', () => {
    const t = txn({ utr: '123456789012', amountMinor: 999 });
    const e = entry({ reference: '123456789012', postingDate: '2026-10-01', party: 'Someone else' });
    expect(findSimilar(t, [e])).toEqual({ entry: e, strength: 'strong', why: 'reference' });
  });

  it('same amount, same date and same normalised party is strong', () => {
    const e = entry({ party: 'hp fuel-station' });
    expect(findSimilar(txn(), [e])).toEqual({ entry: e, strength: 'strong', why: 'details' });
  });

  it('matches the counterparty as well as the merchant', () => {
    const e = entry({ party: 'Ravi Kumar' });
    expect(findSimilar(txn({ merchant: null, counterparty: 'RAVI KUMAR' }), [e])?.strength).toBe('strong');
  });

  it('same amount within 3 days and no party information is weak', () => {
    const e = entry({ party: null, postingDate: '2026-11-05' });
    expect(findSimilar(txn(), [e])).toEqual({ entry: e, strength: 'weak', why: 'details' });
    expect(findSimilar(txn({ merchant: null }), [entry({ postingDate: '2026-11-11' })])?.strength).toBe('weak');
  });

  it('4 days apart does not match', () => {
    expect(findSimilar(txn(), [entry({ party: null, postingDate: '2026-11-04' })])).toBeNull();
    expect(findSimilar(txn(), [entry({ party: null, postingDate: '2026-11-12' })])).toBeNull();
  });

  it('same party a few days apart is weak', () => {
    expect(findSimilar(txn(), [entry({ postingDate: '2026-11-10' })])?.strength).toBe('weak');
  });

  it('a different party on the same amount and day does not match', () => {
    expect(findSimilar(txn(), [entry({ party: 'Indian Oil' })])).toBeNull();
  });

  it('a different amount never matches', () => {
    expect(findSimilar(txn(), [entry({ amountMinor: 50100 })])).toBeNull();
  });

  it('amounts are compared in paise', () => {
    const t = txn({ amountMinor: 100040 });
    expect(findSimilar(t, [entry({ amountMinor: 100000 })])).toBeNull();
    expect(findSimilar(t, [entry({ amountMinor: 100040 })])?.strength).toBe('strong');
  });

  it('the opposite direction never matches', () => {
    expect(findSimilar(txn(), [entry({ direction: 'in' })])).toBeNull();
    expect(findSimilar(txn({ utr: 'R1' }), [entry({ direction: 'in', reference: 'R1' })])).toBeNull();
    // A Journal Entry has no direction: it can still match.
    expect(findSimilar(txn(), [entry({ doctype: 'Journal Entry', direction: null, party: null })])?.strength).toBe('weak');
  });

  it('a foreign-currency amount is not compared with rupee entries', () => {
    expect(findSimilar(txn({ currency: 'USD' }), [entry()])).toBeNull();
    expect(findSimilar(txn({ currency: 'USD', utr: 'R1' }), [entry({ reference: 'R1' })])?.strength).toBe('strong');
  });

  it('a cancelled entry is ignored even if passed in', () => {
    expect(findSimilar(txn(), [entry({ docstatus: 2 as never })])).toBeNull();
    expect(findSimilar(txn({ utr: 'R1' }), [entry({ docstatus: 2 as never, reference: 'R1' })])).toBeNull();
    expect(findSimilar(txn(), [entry({ docstatus: 1 })])?.strength).toBe('strong');
  });

  it('the entry the app created for this txn is not a duplicate', () => {
    // Its own reference when there is no UTR.
    expect(findSimilar(txn(), [entry({ reference: 'AL-abc123' })])).toBeNull();
    // A document recorded on the txn itself (it carries the txn's UTR).
    const own = txn({ utr: 'U1', createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }] });
    expect(findSimilar(own, [entry({ reference: 'U1' })])).toBeNull();
    // The same name in another doctype is someone else's.
    expect(findSimilar(own, [entry({ doctype: 'Journal Entry', reference: 'U1' })])?.strength).toBe('strong');
  });

  it('another txn\'s app reference is still reported (two real ₹500 payments)', () => {
    expect(findSimilar(txn(), [entry({ reference: 'AL-other' })])?.strength).toBe('strong');
  });

  it('the closest date wins, then strong over weak, then the earlier entry', () => {
    const far = entry({ name: 'FAR', postingDate: '2026-11-06', party: null });
    const near = entry({ name: 'NEAR', postingDate: '2026-11-07', party: null });
    expect(findSimilar(txn(), [far, near])?.entry.name).toBe('NEAR');
    const weak = entry({ name: 'WEAK', party: null });
    const strong = entry({ name: 'STRONG' });
    expect(findSimilar(txn(), [weak, strong])?.entry.name).toBe('STRONG');
    const a = entry({ name: 'A' });
    const b = entry({ name: 'B' });
    expect(findSimilar(txn(), [a, b])?.entry.name).toBe('A');
    expect(findSimilar(txn(), [b, a])?.entry.name).toBe('B');
  });

  it('a reference match ranks above a date-closer amount match', () => {
    const t = txn({ utr: 'R1' });
    const near = entry({ name: 'NEAR', party: null });
    const byRef = entry({ name: 'REF', reference: 'R1', postingDate: '2026-10-01', amountMinor: 1 });
    expect(findSimilar(t, [near, byRef])).toEqual({ entry: byRef, strength: 'strong', why: 'reference' });
  });

  it('entries the caller excludes are skipped and the next best one is used', () => {
    const a = entry({ name: 'A' });
    const b = entry({ name: 'B', party: null, postingDate: '2026-11-07' });
    expect(findSimilar(txn(), [a, b], (e) => e.name === 'A')?.entry.name).toBe('B');
    expect(findSimilar(txn(), [a], (e) => e.name === 'A')).toBeNull();
  });

  it('no entries, no hit', () => {
    expect(findSimilar(txn(), [])).toBeNull();
  });
});
