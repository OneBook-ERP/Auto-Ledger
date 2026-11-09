import fixtures from '../../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from './parser';
import { learnRule, normalizeKey, suggest } from './suggest';
import type { ActionChoice, OpenInvoice, ParsedTxn, PartyRef, PendingTxn, Rule } from './types';

function pending(id: string, over: Partial<PendingTxn> = {}): PendingTxn {
  const f = (fixtures as { id: string; sender: string; body: string; receivedAt: number }[]).find((x) => x.id === id)!;
  const r = parseSms(f.sender, f.body, f.receivedAt, bundledTemplates);
  if (!r.ok) throw new Error(`fixture ${id} did not parse`);
  const t: ParsedTxn = r.txn;
  return { ...t, id: 'p1', mergedCount: 1, state: 'new', createdDocs: [], error: null, ...over };
}
const fb = () => pending('idfc-035'); // card_spend, merchant "FACEBOOK SI"
const rule = (o: Partial<Rule>): Rule => ({ matchKey: 'm:out:facebooksi', action: 'expense', account: 'Advertising - ZP', hits: 1, lastUsed: 1, ...o });

describe('suggest: rules', () => {
  it('merchant rule yields an expense suggestion with its account', () => {
    const s = suggest(fb(), [rule({})], [], []);
    expect(s).toHaveLength(1);
    expect(s[0].reason).toBe('rule');
    expect(s[0].choice).toEqual({ type: 'expense', expenseAccount: 'Advertising - ZP' });
    expect(s[0].confidence).toBeCloseTo(0.82, 5);
  });
  it('confidence is capped at 0.99', () => {
    expect(suggest(fb(), [rule({ hits: 50 })], [], [])[0].confidence).toBe(0.99);
  });
  it('rule keys are direction-separated', () => {
    const t = pending('idfc-006'); // credit from COMPANY_11
    const asSupplier = rule({ matchKey: 'cp:out:company11', action: 'supplier_payment', account: undefined, party: { doctype: 'Supplier', name: 'S' } });
    expect(suggest(t, [asSupplier], [], [])).toEqual([]);
    const asCustomer = rule({ matchKey: 'cp:in:company11', action: 'customer_advance', account: undefined, party: { doctype: 'Customer', name: 'C' } });
    const s = suggest(t, [asCustomer, asSupplier], [], []);
    expect(s).toHaveLength(1);
    expect(s[0].choice).toEqual({ type: 'customer_advance', party: { doctype: 'Customer', name: 'C' } });
  });
  it('other_income maps account to incomeAccount', () => {
    const t = pending('idfc-006');
    const s = suggest(t, [rule({ matchKey: 'cp:in:company11', action: 'other_income', account: 'Interest - ZP' })], [], []);
    expect(s[0].choice).toEqual({ type: 'other_income', incomeAccount: 'Interest - ZP' });
  });
  it('utr rule gets reason utr and confidence 1', () => {
    const t = pending('idfc-010');
    const s = suggest(t, [rule({ matchKey: `utr:${t.utr}`, action: 'supplier_payment', account: undefined, party: { doctype: 'Supplier', name: 'S' } })], [], []);
    expect(s[0].reason).toBe('utr');
    expect(s[0].confidence).toBe(1);
  });
  it('counterparty is used in preference to merchant', () => {
    const t = pending('idfc-035', { counterparty: 'Someone' });
    expect(suggest(t, [rule({})], [], [])).toEqual([]);
  });
});

describe('suggest: exact invoice amount', () => {
  const pi = (name: string, outstandingMinor: number): OpenInvoice => ({ doctype: 'Purchase Invoice', name, outstandingMinor, dueDate: '2026-12-01' });
  const si = (name: string, outstandingMinor: number): OpenInvoice => ({ doctype: 'Sales Invoice', name, outstandingMinor, dueDate: '2026-12-01' });
  it('debit with exactly one matching Purchase Invoice', () => {
    const t = pending('idfc-010'); // 30,000.00 debit
    const s = suggest(t, [], [pi('PINV-1', 3000000), pi('PINV-2', 5), si('SINV-1', 3000000)], []);
    expect(s).toHaveLength(1);
    expect(s[0]).toEqual({
      choice: { type: 'against_invoice', invoices: [{ doctype: 'Purchase Invoice', name: 'PINV-1', allocatedMinor: 3000000 }] },
      reason: 'exact_invoice_amount', confidence: 0.75,
    });
  });
  it('credit uses Sales Invoices only', () => {
    const t = pending('idfc-006'); // 30,000.00 credit
    const s = suggest(t, [], [pi('PINV-1', 3000000), si('SINV-1', 3000000)], []);
    expect(s).toHaveLength(1);
    expect((s[0].choice as { invoices: { name: string }[] }).invoices[0].name).toBe('SINV-1');
  });
  it('ambiguous amounts yield none', () => {
    expect(suggest(pending('idfc-010'), [], [pi('A', 3000000), pi('B', 3000000)], [])).toEqual([]);
  });
});

describe('suggest: name match', () => {
  const customers: PartyRef[] = [{ doctype: 'Customer', name: 'Acme Test Traders Pvt Ltd' }, { doctype: 'Supplier', name: 'Acme Test Traders' }];
  it('fuzzy matches counterparty to customer for a credit', () => {
    const t = pending('idfc-006', { counterparty: 'ACME TEST TRADERS' });
    const s = suggest(t, [], [], customers);
    expect(s).toEqual([{ choice: { type: 'customer_advance', party: customers[0] }, reason: 'name_match', confidence: 0.7 }]);
  });
  it('debit matches suppliers, employees get salary', () => {
    const t = pending('idfc-010', { counterparty: 'Ravi Kumar' });
    const s = suggest(t, [], [], [{ doctype: 'Employee', name: 'Ravi Kumar' }, { doctype: 'Supplier', name: 'Ravi Kumar Ltd.' }, { doctype: 'Customer', name: 'Ravi Kumar' }]);
    expect(s.map((x) => x.choice.type).sort()).toEqual(['salary', 'supplier_payment']);
  });
  it('threshold: 0.5 rejected, 0.67 accepted', () => {
    const t = pending('idfc-006', { counterparty: 'alpha beta' });
    expect(suggest(t, [], [], [{ doctype: 'Customer', name: 'alpha beta gamma delta' }])).toEqual([]); // 0.5
    const s = suggest(t, [], [], [{ doctype: 'Customer', name: 'alpha beta gamma' }]); // 0.667
    expect(s).toHaveLength(1);
    expect(s[0].confidence).toBe(0.47);
  });
  it('suffix-only names do not match', () => {
    const t = pending('idfc-006', { counterparty: 'Pvt Ltd' });
    expect(suggest(t, [], [], [{ doctype: 'Customer', name: 'Company Limited' }])).toEqual([]);
  });
});

describe('suggest: ordering and shape', () => {
  it('orders by confidence, reason priority, then party name; caps at 5', () => {
    const t = pending('idfc-006', { counterparty: 'zed' });
    const parties: PartyRef[] = ['d', 'c', 'b', 'a'].map((n) => ({ doctype: 'Customer' as const, name: 'zed' + (n === 'a' ? '' : '') + (n === 'a' ? '' : ' ' + n) }));
    // exact name 'zed' -> 1.0*0.7; others 0.5 -> rejected; add many exact duplicates by distinct doctype-less names
    const many: PartyRef[] = ['Zed', 'zed.', 'ZED', 'Zed Pvt Ltd', 'zed co', 'zed inc', 'the zed'].map((n) => ({ doctype: 'Customer' as const, name: n }));
    const s = suggest(t, [rule({ matchKey: 'cp:in:zed', action: 'ignore', account: undefined })], [], [...parties, ...many]);
    expect(s).toHaveLength(5);
    expect(s[0].reason).toBe('rule');
    const names = s.slice(1).map((x) => (x.choice as { party: PartyRef }).party.name);
    expect(names).toEqual([...names].sort());
    expect(suggest(t, [rule({ matchKey: 'cp:in:zed', action: 'ignore', account: undefined })], [], [...many, ...parties].reverse())).toEqual(s);
  });
  it('utr outranks rule at equal confidence ordering', () => {
    const t = pending('idfc-010');
    const s = suggest(t, [rule({ matchKey: 'cp:out:person13', action: 'personal', account: undefined, hits: 50 }), rule({ matchKey: `utr:${t.utr}`, action: 'ignore', account: undefined })], [], []);
    expect(s.map((x) => x.reason)).toEqual(['utr', 'rule']);
  });
  it('never carries an auto-post flag', () => {
    const t = pending('idfc-010', { counterparty: 'Acme Test Traders' });
    const s = suggest(t, [rule({ matchKey: 'cp:out:acmetesttraders', action: 'expense' })], [{ doctype: 'Purchase Invoice', name: 'P', outstandingMinor: 3000000, dueDate: 'x' }], [{ doctype: 'Supplier', name: 'Acme Test Traders' }]);
    expect(s.length).toBeGreaterThanOrEqual(3);
    for (const x of s) expect(Object.keys(x)).toEqual(['choice', 'reason', 'confidence']);
  });
  it('does not mutate inputs', () => {
    const t = fb(); const rules = [rule({})];
    const snap = JSON.stringify([t, rules]);
    suggest(t, rules, [], []);
    expect(JSON.stringify([t, rules])).toBe(snap);
  });
});

describe('normalizeKey', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(normalizeKey('IND*LinkedIn (PGSI)')).toBe('indlinkedinpgsi');
  });
});

describe('learnRule', () => {
  const sup: PartyRef = { doctype: 'Supplier', name: 'S' };
  const exp: ActionChoice = { type: 'expense', expenseAccount: 'Ads - ZP' };
  it('creates a new rule with hits 1', () => {
    const t = fb();
    const r = learnRule(t, exp, []);
    expect(r).toEqual([{ matchKey: 'm:out:facebooksi', action: 'expense', account: 'Ads - ZP', hits: 1, lastUsed: t.receivedAt, maxAmountMinor: t.amountMinor, currency: 'INR' }]);
  });
  it('increments hits on repeat and updates account', () => {
    const t = fb();
    const first = learnRule(t, exp, []);
    const second = learnRule({ ...t, receivedAt: t.receivedAt + 5 }, { type: 'expense', expenseAccount: 'Mkt - ZP' }, first);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ hits: 2, account: 'Mkt - ZP', lastUsed: t.receivedAt + 5 });
    expect(first[0].hits).toBe(1);
  });
  it('same key with a different action adds a new rule', () => {
    const t = fb();
    const r = learnRule(t, { type: 'personal' }, learnRule(t, exp, []));
    expect(r).toHaveLength(2);
    expect(r[1]).toMatchObject({ action: 'personal', hits: 1 });
  });
  it('uses counterparty with direction, supplier party stored', () => {
    const t = pending('idfc-010');
    const r = learnRule(t, { type: 'supplier_payment', party: sup }, []);
    expect(r[0]).toMatchObject({ matchKey: 'cp:out:person13', action: 'supplier_payment', party: sup });
  });
  it('learns ignore and personal', () => {
    expect(learnRule(fb(), { type: 'ignore' }, [])).toHaveLength(1);
    expect(learnRule(fb(), { type: 'personal' }, [])).toHaveLength(1);
  });
  it('skips against_invoice and bill_paid_by_card', () => {
    const existing: Rule[] = [];
    const t = pending('idfc-010');
    const a = learnRule(t, { type: 'against_invoice', party: sup, invoices: [] }, existing);
    const b = learnRule(t, { type: 'bill_paid_by_card', party: sup, invoice: { name: 'x', allocatedMinor: 1 } }, existing);
    expect(a).toBe(existing); expect(b).toBe(existing);
  });
  it('returns input when no counterparty/merchant/utr', () => {
    const t = pending('idfc-001');
    const existing: Rule[] = [];
    expect(learnRule(t, exp, existing)).toBe(existing);
  });
  it('does not mutate inputs and returns a new array', () => {
    const t = fb();
    const existing = learnRule(t, exp, []);
    const snap = JSON.stringify(existing);
    const out = learnRule(t, exp, existing);
    expect(JSON.stringify(existing)).toBe(snap);
    expect(out).not.toBe(existing);
  });
});

describe('R40 fixes', () => {
  const bank = { bankAccount: 'b', glAccount: 'g', kind: 'bank' as const, senderIds: [], last4: [], modeOfPayment: 'm' };
  it('an incoming transfer (fromAccount) is not learned, and a stored transfer rule suggests nothing', () => {
    const existing: Rule[] = [];
    const t = pending('idfc-006');
    expect(learnRule(t, { type: 'transfer', fromAccount: { bankAccount: 'ICICI', glAccount: 'ICICI - ZP' } }, existing)).toBe(existing);
    expect(suggest(t, [{ matchKey: 'cp:in:company11', action: 'transfer', hits: 9, lastUsed: 1 }], [], [])).toEqual([]);
  });
  it('transfer is not learned', () => {
    const existing: Rule[] = [];
    expect(learnRule(pending('idfc-010'), { type: 'transfer', toAccount: bank }, existing)).toBe(existing);
  });
  it('incomplete stored rules produce no suggestion', () => {
    const t = fb();
    const mk = (o: Partial<Rule>) => suggest(t, [{ matchKey: 'm:out:facebooksi', action: 'expense', hits: 1, lastUsed: 1, ...o }], [], []);
    expect(mk({ action: 'transfer' })).toEqual([]);
    expect(mk({ action: 'supplier_payment' })).toEqual([]);
    expect(mk({ action: 'salary' })).toEqual([]);
    expect(mk({ action: 'customer_advance' })).toEqual([]);
    expect(mk({ action: 'expense' })).toEqual([]);
    expect(mk({ action: 'other_income' })).toEqual([]);
    expect(mk({ action: 'personal' })).toHaveLength(1);
    expect(mk({ action: 'ignore' })).toHaveLength(1);
  });
  it('Devanagari counterparty round-trips and matras do not collide', () => {
    const a = pending('idfc-010', { counterparty: 'राम कुमार' });
    const b = pending('idfc-010', { counterparty: 'रम कुमर' });
    expect(normalizeKey('राम')).not.toBe(normalizeKey('रम'));
    const rules = learnRule(a, { type: 'personal' }, []);
    expect(rules).toHaveLength(1);
    expect(suggest(a, rules, [], [])).toHaveLength(1);
    expect(suggest(b, rules, [], [])).toEqual([]);
  });
  it('Tamil name round-trips', () => {
    const t = pending('idfc-010', { counterparty: 'தமிழ் கடை' });
    expect(suggest(t, learnRule(t, { type: 'ignore' }, []), [], [])).toHaveLength(1);
  });
  it('marks/punctuation-only name yields no rule', () => {
    const t = pending('idfc-010', { counterparty: '\u0903 ..', merchant: null, utr: null });
    const existing: Rule[] = [];
    expect(learnRule(t, { type: 'personal' }, existing)).toBe(existing);
  });
  it('punctuation-only counterparty falls back to merchant', () => {
    const t = pending('idfc-010', { counterparty: '--', merchant: 'Shop X' });
    expect(learnRule(t, { type: 'personal' }, [])[0].matchKey).toBe('m:out:shopx');
  });
  it('doctype tie-break gives input-order independent output', () => {
    const t = pending('idfc-010', { counterparty: 'Sam Roy' });
    const ps: PartyRef[] = [{ doctype: 'Supplier', name: 'Sam Roy' }, { doctype: 'Employee', name: 'Sam Roy' }];
    const s1 = suggest(t, [], [], ps);
    const s2 = suggest(t, [], [], [...ps].reverse());
    expect(s1).toEqual(s2);
    expect(s1.map((x) => x.choice.type)).toEqual(['salary', 'supplier_payment']);
  });
});
