import { actionsFor, nextStep, partyDoctypeFor, rememberDefault, rememberShown } from './actions';
import { txnFrom } from './testData';

const labels = (dir: 'in' | 'out', kind: 'bank' | 'card') => actionsFor(dir, kind).map((a) => a.label);

describe('actionsFor (spec section 8 / 9)', () => {
  it('credit: customer advance, against invoice, other income, transfer, personal, ignore', () => {
    expect(labels('in', 'bank')).toEqual([
      'Customer advance', 'Payment against an invoice', 'Other income', 'Transfer between my accounts', 'Personal', 'Ignore this message',
    ]);
  });
  it('debit on a bank account', () => {
    expect(labels('out', 'bank')).toEqual([
      'Supplier payment', 'Payment against a bill', 'Expense', 'Salary/Employee payment', 'Transfer between my accounts', 'Personal', 'Ignore this message',
    ]);
  });
  it('debit on a card: expense first, no transfer', () => {
    expect(labels('out', 'card')).toEqual(['Expense', 'Bill paid by card', 'Personal', 'Ignore this message']);
    expect(actionsFor('out', 'card').map((a) => a.type)).not.toContain('transfer');
  });
  it('maps labels to planner action types', () => {
    expect(actionsFor('in', 'bank').map((a) => a.type)).toEqual(['customer_advance', 'against_invoice', 'other_income', 'transfer', 'personal', 'ignore']);
    expect(actionsFor('out', 'bank').map((a) => a.type)).toEqual(['supplier_payment', 'against_invoice', 'expense', 'salary', 'transfer', 'personal', 'ignore']);
    expect(actionsFor('out', 'card').map((a) => a.type)).toEqual(['expense', 'bill_paid_by_card', 'personal', 'ignore']);
  });
});

describe('partyDoctypeFor', () => {
  it.each([
    ['customer_advance', 'in', 'Customer'],
    ['against_invoice', 'in', 'Customer'],
    ['against_invoice', 'out', 'Supplier'],
    ['supplier_payment', 'out', 'Supplier'],
    ['bill_paid_by_card', 'out', 'Supplier'],
    ['expense', 'out', 'Supplier'],
    ['salary', 'out', 'Employee'],
  ] as const)('%s (%s) -> %s', (type, dir, want) => {
    expect(partyDoctypeFor(type, dir)).toBe(want);
  });
  it('none for accounts-only actions', () => {
    expect(partyDoctypeFor('other_income', 'in')).toBeNull();
    expect(partyDoctypeFor('personal', 'out')).toBeNull();
  });
});

describe('nextStep', () => {
  const credit = txnFrom('idfc-006');
  const debit = txnFrom('idfc-010');
  const usd = txnFrom('idfc-040');
  const acme = { doctype: 'Customer' as const, name: 'Acme' };
  it('party actions ask for the party first', () => {
    expect(nextStep(credit, { action: 'customer_advance' })).toBe('party');
    expect(nextStep(credit, { action: 'customer_advance', party: acme })).toBe('confirm');
    expect(nextStep(debit, { action: 'salary' })).toBe('party');
  });
  it('invoice actions: party, then invoices', () => {
    expect(nextStep(credit, { action: 'against_invoice' })).toBe('party');
    expect(nextStep(credit, { action: 'against_invoice', party: acme })).toBe('invoices');
    expect(nextStep(credit, { action: 'against_invoice', party: acme, invoices: [{ doctype: 'Sales Invoice', name: 'S1', allocatedMinor: 1 }] })).toBe('confirm');
  });
  it('account actions ask for the account', () => {
    expect(nextStep(debit, { action: 'expense' })).toBe('account');
    expect(nextStep(debit, { action: 'expense', account: 'Rent - ZP' })).toBe('confirm');
    expect(nextStep(credit, { action: 'other_income' })).toBe('account');
    expect(nextStep(debit, { action: 'transfer' })).toBe('account');
  });
  it('a credit transfer needs no further answer; personal and ignore go straight to confirm', () => {
    expect(nextStep(credit, { action: 'transfer' })).toBe('confirm');
    expect(nextStep(debit, { action: 'personal' })).toBe('confirm');
    expect(nextStep(debit, { action: 'ignore' })).toBe('confirm');
  });
  it('a foreign-currency spend asks for the rupee amount before anything else (not for ignore)', () => {
    expect(nextStep(usd, { action: 'expense', account: 'Software - ZP' })).toBe('amount');
    expect(nextStep(usd, { action: 'expense', inrAmountMinor: 850000 })).toBe('account');
    expect(nextStep(usd, { action: 'ignore' })).toBe('confirm');
  });
  it('no action yet: stay on the transaction', () => {
    expect(nextStep(debit, {})).toBe('choose');
  });
});

describe('remember choice toggle', () => {
  it('on by default for learnable actions, hidden for invoice / card bill / transfer', () => {
    for (const t of ['expense', 'customer_advance', 'supplier_payment', 'salary', 'other_income', 'personal', 'ignore'] as const) {
      expect(rememberShown(t)).toBe(true);
      expect(rememberDefault(t)).toBe(true);
    }
    for (const t of ['against_invoice', 'bill_paid_by_card', 'transfer'] as const) expect(rememberShown(t)).toBe(false);
  });
});
