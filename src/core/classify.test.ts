import { AUTO_ACTIONS, canAutoApply, groupSimilar } from './classify';
import { learnRule } from './suggest';
import type { ActionChoice, PendingTxn, Rule } from './types';

let seq = 0;
function txn(over: Partial<PendingTxn> = {}): PendingTxn {
  seq += 1;
  return {
    id: `t${seq}`, mergedCount: 1, state: 'new', createdDocs: [], error: null,
    kind: 'card_spend', direction: 'out', amountMinor: 50000, currency: 'INR',
    occurredOn: '2026-11-01', occurredTime: '10:00', accountType: 'card', accountLast4: '1234',
    counterparty: null, utr: null, merchant: 'FACEBOOK', balanceMinor: null,
    sender: 'AX-IDFCFB', receivedAt: 1700000000000 + seq, rawHash: `h${seq}`, ...over,
  };
}
const fbRule = (o: Partial<Rule> = {}): Rule => ({
  matchKey: 'm:out:facebook', action: 'expense', account: 'Advertising - ZP', hits: 3, lastUsed: 1,
  auto: true, maxAmountMinor: 100000, currency: 'INR', ...o,
});

describe('groupSimilar', () => {
  it('groups items with the same normalised merchant and direction; singletons are not groups', () => {
    const a = txn({ merchant: 'FACEBOOK' });
    const b = txn({ merchant: 'Facebook.' });
    const c = txn({ merchant: 'SWIGGY' });
    const g = groupSimilar([a, b, c], []);
    expect(g).toEqual([{ key: 'm:out:facebook', items: [a, b], suggestion: null }]);
  });
  it('uses the exact key: "facebook" never groups with "facebookads pvt"', () => {
    const a = txn({ merchant: 'FACEBOOK' });
    const b = txn({ merchant: 'FACEBOOKADS PVT' });
    const c = txn({ merchant: 'FACEBOOK' });
    const d = txn({ merchant: 'FACEBOOKADS PVT' });
    const g = groupSimilar([a, b, c, d], []);
    expect(g.map((x) => [x.key, x.items.map((i) => i.id)])).toEqual([
      ['m:out:facebook', [a.id, c.id]],
      ['m:out:facebookadspvt', [b.id, d.id]],
    ]);
  });
  it('separates directions and prefers the counterparty over the merchant', () => {
    const a = txn({ counterparty: 'ACME', merchant: null, direction: 'in' });
    const b = txn({ counterparty: 'ACME', merchant: null, direction: 'out' });
    const c = txn({ counterparty: 'Acme', merchant: 'X', direction: 'in' });
    const g = groupSimilar([a, b, c], []);
    expect(g).toEqual([{ key: 'cp:in:acme', items: [a, c], suggestion: null }]);
  });
  it('items without a name are never grouped', () => {
    expect(groupSimilar([txn({ merchant: null }), txn({ merchant: null })], [])).toEqual([]);
  });
  it('carries the rule suggestion for the exact key only; largest group first', () => {
    const fb = [txn(), txn()];
    const sw = [txn({ merchant: 'SWIGGY' }), txn({ merchant: 'SWIGGY' }), txn({ merchant: 'SWIGGY' })];
    const g = groupSimilar([...fb, ...sw], [fbRule(), fbRule({ matchKey: 'm:out:face' })]);
    expect(g.map((x) => x.key)).toEqual(['m:out:swiggy', 'm:out:facebook']);
    expect(g[1].suggestion).toEqual({ type: 'expense', expenseAccount: 'Advertising - ZP' });
    expect(g[0].suggestion).toBeNull();
  });
  it('a rule without a complete answer gives no suggestion', () => {
    const g = groupSimilar([txn(), txn()], [fbRule({ account: undefined })]);
    expect(g[0].suggestion).toBeNull();
  });
});

describe('canAutoApply', () => {
  it('true for a normal Facebook card spend under a confirmed automatic rule', () => {
    expect(canAutoApply(txn({ amountMinor: 80000 }), fbRule(), false)).toBe(true);
    expect(canAutoApply(txn({ amountMinor: 200000 }), fbRule(), false)).toBe(true); // exactly 2x
  });
  it('false when the rule is not automatic', () => {
    expect(canAutoApply(txn(), fbRule({ auto: false }), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ auto: undefined }), false)).toBe(false);
  });
  it('false for any action outside the allowed five', () => {
    expect([...AUTO_ACTIONS].sort()).toEqual(['expense', 'ignore', 'other_income', 'personal', 'supplier_payment']);
    const party = { doctype: 'Supplier' as const, name: 'S' };
    for (const action of ['customer_advance', 'salary', 'against_invoice', 'bill_paid_by_card', 'transfer'] as const) {
      expect(canAutoApply(txn(), fbRule({ action, party, account: undefined }), false)).toBe(false);
    }
  });
  it('true for the other allowed actions when the direction fits', () => {
    const party = { doctype: 'Supplier' as const, name: 'S' };
    expect(canAutoApply(txn(), fbRule({ action: 'supplier_payment', party, account: undefined }), false)).toBe(true);
    expect(canAutoApply(txn(), fbRule({ action: 'personal', account: undefined }), false)).toBe(true);
    expect(canAutoApply(txn(), fbRule({ action: 'ignore', account: undefined }), false)).toBe(true);
    const inc = txn({ direction: 'in' });
    expect(canAutoApply(inc, fbRule({ matchKey: 'm:in:facebook', action: 'other_income', account: 'Other Income - ZP' }), false)).toBe(true);
  });
  it('false for a foreign-currency charge', () => {
    expect(canAutoApply(txn({ currency: 'USD', amountMinor: 1000 }), fbRule(), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ currency: 'USD' }), false)).toBe(false);
  });
  it('false above 2x the largest confirmed amount, or with no confirmed amount', () => {
    expect(canAutoApply(txn({ amountMinor: 200001 }), fbRule(), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ maxAmountMinor: undefined }), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ maxAmountMinor: 0 }), false)).toBe(false);
    expect(canAutoApply(txn({ amountMinor: 0 }), fbRule(), false)).toBe(false);
  });
  it('false with a duplicate flag', () => {
    expect(canAutoApply(txn(), fbRule(), true)).toBe(false);
  });
  it('false on a direction mismatch', () => {
    // Same name, money in: the key differs, and an expense never fits money in.
    expect(canAutoApply(txn({ direction: 'in' }), fbRule(), false)).toBe(false);
    expect(canAutoApply(txn({ direction: 'in' }), fbRule({ matchKey: 'm:in:facebook' }), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ matchKey: 'm:out:facebook', action: 'other_income', account: 'Inc' }), false)).toBe(false);
  });
  it('false for a rule without a complete answer', () => {
    expect(canAutoApply(txn(), fbRule({ account: undefined }), false)).toBe(false);
    expect(canAutoApply(txn(), fbRule({ action: 'supplier_payment', account: undefined }), false)).toBe(false);
  });
  it('false unless the pattern key is an exact normalised match', () => {
    expect(canAutoApply(txn({ merchant: 'FACEBOOKADS PVT' }), fbRule(), false)).toBe(false);
    expect(canAutoApply(txn({ merchant: 'FACEBOO' }), fbRule(), false)).toBe(false);
    // A reference (UTR) rule is never automatic.
    expect(canAutoApply(txn({ utr: 'U1' }), fbRule({ matchKey: 'utr:U1' }), false)).toBe(false);
  });
  it('false for an item that is no longer waiting', () => {
    expect(canAutoApply(txn({ state: 'created' }), fbRule(), false)).toBe(false);
  });
});

describe('learnRule: trust fields', () => {
  const exp: ActionChoice = { type: 'expense', expenseAccount: 'Advertising - ZP' };
  it('records the confirmed rupee amount and keeps the largest', () => {
    const r1 = learnRule(txn({ amountMinor: 50000 }), exp, []);
    expect(r1[0]).toMatchObject({ maxAmountMinor: 50000, currency: 'INR' });
    expect(r1[0].auto).toBeUndefined();
    const r2 = learnRule(txn({ amountMinor: 90000 }), exp, r1);
    expect(r2[0]).toMatchObject({ maxAmountMinor: 90000, currency: 'INR', hits: 2 });
    const r3 = learnRule(txn({ amountMinor: 10000 }), exp, r2);
    expect(r3[0]).toMatchObject({ maxAmountMinor: 90000, hits: 3 });
  });
  it('a foreign-currency answer never sets or raises the rupee maximum', () => {
    const r1 = learnRule(txn({ currency: 'USD', amountMinor: 999999 }), exp, []);
    expect(r1[0].maxAmountMinor).toBeUndefined();
    expect(r1[0].currency).toBeUndefined();
    const r2 = learnRule(txn({ currency: 'USD', amountMinor: 999999 }), exp, learnRule(txn({ amountMinor: 100 }), exp, []));
    expect(r2[0]).toMatchObject({ maxAmountMinor: 100, currency: 'INR', hits: 2 });
  });
  it('the same answer keeps the automatic switch', () => {
    const on = learnRule(txn(), exp, [fbRule({ maxAmountMinor: 70000 })]);
    expect(on[0]).toMatchObject({ auto: true, maxAmountMinor: 70000, hits: 4 });
  });
  it('a changed answer turns automatic off and restarts the maximum', () => {
    const changed = learnRule(txn({ amountMinor: 30000 }), { type: 'expense', expenseAccount: 'Marketing - ZP' }, [fbRule()]);
    expect(changed[0].auto).toBeUndefined();
    expect(changed[0]).toMatchObject({ account: 'Marketing - ZP', maxAmountMinor: 30000 });
    // A different action for the same name is a new rule (the repo replaces the old one by key): not automatic.
    const other = learnRule(txn(), { type: 'personal' }, [fbRule()]);
    expect(other.find((r) => r.action === 'personal')?.auto).toBeUndefined();
  });
  it('raiseMax false (an automatic answer) counts the use but never raises the maximum', () => {
    const r = learnRule(txn({ amountMinor: 190000 }), exp, [fbRule()], { raiseMax: false });
    expect(r[0]).toMatchObject({ maxAmountMinor: 100000, hits: 4, auto: true });
  });
});
