import { PlanError } from '../core/plan';
import {
  RATE_MAX_PAISE, RATE_MIN_PAISE, buildNewParty, foreignAmountCheck, defaultAllocation, effectiveAmountMinor, parseRupees, planFor, toPaise, validateAllocations, validateNewParty,
} from './flow';
import { BANK, CARD, txnFrom } from './testData';

const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-11-08' };
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof PlanError ? e.code : String(e);
  }
  return 'no error';
};

describe('parseRupees', () => {
  it.each([
    ['8500', 850000], ['8,500.50', 850050], [' 1,00,000 ', 10000000], ['0.5', 50], ['12.', 1200],
  ])('%p -> %p paise', (s, want) => expect(parseRupees(s)).toBe(want));
  it.each(['', 'abc', '0', '-5', '1.234', '1e3', '..'])('rejects %p', (s) => expect(parseRupees(s)).toBeNull());
  it('toPaise shows paise as a plain rupee string for editing', () => {
    expect(toPaise(850050)).toBe('8500.50');
    expect(toPaise(100)).toBe('1.00');
  });
});

describe('planFor', () => {
  const credit = txnFrom('idfc-006');
  const debit = txnFrom('idfc-010');
  const acme = { doctype: 'Customer' as const, name: 'Acme Test Traders' };

  it('customer advance: one Payment Entry with the mapping and today', () => {
    const { plan, choice } = planFor(credit, { mapping: BANK, action: 'customer_advance', party: acme }, settings);
    expect(choice).toEqual({ type: 'customer_advance', party: acme });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].body).toMatchObject({ party: 'Acme Test Traders', mode_of_payment: 'Wire Transfer', paid_to: 'IDFC First - ZP' });
  });
  it('a new party adds a create_party step first', () => {
    const newParty = buildNewParty('Customer', 'Acme Test Traders', { customer_group: 'Commercial' });
    const { plan } = planFor(credit, { mapping: BANK, action: 'customer_advance', party: newParty.ref, newParty }, settings);
    expect(plan.steps.map((s) => s.kind)).toEqual(['create_party', 'create_doc']);
    expect(plan.steps[0].body).toEqual({ customer_name: 'Acme Test Traders', customer_group: 'Commercial' });
    expect(plan.summary[0]).toBe('New Customer will be created: Acme Test Traders');
  });
  it('keeps the ERPNext labels of the extra fields for the confirm screen (not sent)', () => {
    const np = buildNewParty('Customer', 'Acme', { customer_group: 'Commercial' }, [{ fieldname: 'customer_group', label: 'Customer Group', fieldtype: 'Link' }]);
    expect(np.labels).toEqual({ customer_group: 'Customer Group' });
    const { plan } = planFor(credit, { mapping: BANK, action: 'customer_advance', party: np.ref, newParty: np }, settings);
    expect(plan.steps[0].body).toEqual({ customer_name: 'Acme', customer_group: 'Commercial' });
  });
  it('new employee: first_name carries the name', () => {
    expect(buildNewParty('Employee', ' Ravi Kumar ', { gender: 'Male' })).toEqual({
      ref: { doctype: 'Employee', name: 'Ravi Kumar' }, fields: { first_name: 'Ravi Kumar', gender: 'Male' },
    });
    expect(buildNewParty('Supplier', 'Airtel', {}).fields).toEqual({ supplier_name: 'Airtel' });
  });
  it('expense with an optional supplier', () => {
    const s = { doctype: 'Supplier' as const, name: 'Airtel' };
    const { choice } = planFor(debit, { mapping: BANK, action: 'expense', account: 'Telephone - ZP', party: s }, settings);
    expect(choice).toEqual({ type: 'expense', expenseAccount: 'Telephone - ZP', party: s });
  });
  it('transfer out uses the chosen mapping', () => {
    const { plan } = planFor(debit, { mapping: BANK, action: 'transfer', toAccount: CARD }, settings);
    expect(plan.steps[0].body).toMatchObject({ payment_type: 'Internal Transfer', paid_from: 'IDFC First - ZP', paid_to: 'IDFC Credit Card - ZP' });
  });
  it('a credit transfer comes from the chosen bank account (R52b)', () => {
    const from = { bankAccount: 'ICICI Savings', glAccount: 'ICICI - ZP' };
    const { plan, choice } = planFor(credit, { mapping: BANK, action: 'transfer', fromAccount: from }, settings);
    expect(choice).toEqual({ type: 'transfer', fromAccount: from });
    expect(plan.steps[0].body).toMatchObject({ payment_type: 'Internal Transfer', paid_from: 'ICICI - ZP', paid_to: 'IDFC First - ZP', mode_of_payment: 'Wire Transfer' });
    expect(plan.summary[0]).toMatch(/^Internal transfer: ₹30,000.00 from ICICI - ZP into IDFC First - ZP/);
    expect(code(() => planFor(credit, { mapping: BANK, action: 'transfer' }, settings))).toBe('missing_choice');
  });
  it('ignore needs no account, company or rupee amount', () => {
    const { plan, choice } = planFor(txnFrom('idfc-040'), { action: 'ignore' }, { company: '', drawingsAccount: '', today: '2026-11-08' });
    expect(choice).toEqual({ type: 'ignore' });
    expect(plan.steps).toEqual([]);
  });
  it('ignore: the empty plan with a plain summary', () => {
    const { plan } = planFor(debit, { mapping: BANK, action: 'ignore' }, settings);
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toEqual(['Nothing will be added to ERPNext. AutoLedger will not ask about this message again.']);
  });
  it('foreign spend: the rupee amount goes into the plan', () => {
    const usd = txnFrom('idfc-040');
    const { plan } = planFor(usd, { mapping: CARD, action: 'expense', account: 'Software - ZP', inrAmountMinor: 850000 }, settings);
    expect(plan.needsInrAmount).toBe(false);
    expect((plan.steps[0].body.accounts as { debit_in_account_currency?: number }[])[0].debit_in_account_currency).toBe(8500);
    expect(effectiveAmountMinor(usd, { inrAmountMinor: 850000 })).toBe(850000);
    expect(effectiveAmountMinor(usd, {})).toBeNull();
    expect(effectiveAmountMinor(debit, {})).toBe(debit.amountMinor);
  });
  it('missing answers are PlanErrors', () => {
    expect(code(() => planFor(credit, { action: 'customer_advance', party: acme }, settings))).toBe('missing_account');
    expect(code(() => planFor(credit, { mapping: BANK, action: 'customer_advance' }, settings))).toBe('missing_choice');
    expect(code(() => planFor(credit, { mapping: BANK, action: 'personal' }, { ...settings, drawingsAccount: '' }))).toBe('missing_drawings');
    expect(code(() => planFor(credit, { mapping: BANK, action: 'personal' }, { ...settings, company: '' }))).toBe('missing_company');
    expect(code(() => planFor(txnFrom('idfc-040'), { mapping: CARD, action: 'expense', account: 'X' }, settings))).toBe('missing_amount');
  });
  it('planner errors pass through (date out of range)', () => {
    expect(code(() => planFor(credit, { mapping: BANK, action: 'customer_advance', party: acme }, { ...settings, today: '2028-01-01' }))).toBe('date_out_of_range');
  });
});

describe('allocations', () => {
  it('default: the outstanding, capped at what is left of the amount', () => {
    expect(defaultAllocation(100_00, 60_00, [])).toBe(60_00);
    expect(defaultAllocation(100_00, 60_00, [70_00])).toBe(30_00);
    expect(defaultAllocation(100_00, 60_00, [100_00])).toBe(0);
  });
  it('blocks over-allocation, more than the outstanding, and zero', () => {
    const inv = (name: string, outstandingMinor: number, allocatedMinor: number) => ({ name, outstandingMinor, allocatedMinor });
    expect(validateAllocations(100_00, [inv('A', 60_00, 60_00), inv('B', 50_00, 40_00)])).toEqual({ ok: true, totalMinor: 100_00, errors: {} });
    const over = validateAllocations(100_00, [inv('A', 60_00, 60_00), inv('B', 50_00, 50_00)]);
    expect(over.ok).toBe(false);
    expect(over.total).toBe('You allocated ₹110.00, more than the ₹100.00 of this transaction. Lower an amount.');
    expect(validateAllocations(100_00, [inv('A', 60_00, 70_00)]).errors.A).toBe('More than the ₹60.00 still due on A.');
    expect(validateAllocations(100_00, [inv('A', 60_00, 0)]).errors.A).toBe('Enter an amount above zero.');
    expect(validateAllocations(100_00, []).total).toBe('Choose at least one invoice.');
  });
});

describe('validateNewParty', () => {
  const req = [{ fieldname: 'gender', label: 'Gender', fieldtype: 'Link' }, { fieldname: 'date_of_birth', label: 'Date of Birth', fieldtype: 'Date' }];
  it('requires a name and each required field; dates as YYYY-MM-DD', () => {
    expect(validateNewParty('  ', {}, [])).toEqual({ name: 'Enter a name.' });
    expect(validateNewParty('Ravi', { gender: 'Male', date_of_birth: '1990-01-31' }, req)).toEqual({});
    expect(validateNewParty('Ravi', { gender: ' ', date_of_birth: '31/01/1990' }, req)).toEqual({
      gender: 'ERPNext needs Gender.', date_of_birth: 'Enter the date as YYYY-MM-DD, for example 1990-01-31.',
    });
  });
});

describe('foreignAmountCheck', () => {
  const usd = txnFrom('idfc-040'); // USD 100.00
  it('shows the entered rupee value and the implied rate', () => {
    expect(foreignAmountCheck(usd, 850000)).toEqual({ text: 'USD 100.00, entered as ₹8,500.00 (₹85.00 per USD)', warning: null });
  });
  it('warns softly only for an obvious slip: below ₹1 or above ₹1,000 per unit', () => {
    expect(RATE_MIN_PAISE).toBe(100);
    expect(RATE_MAX_PAISE).toBe(100000);
    expect(foreignAmountCheck(usd, 10000).warning).toBeNull(); // ₹1.00 per USD: allowed edge
    expect(foreignAmountCheck(usd, 9999).warning).toBeNull(); // rounds to ₹1.00
    expect(foreignAmountCheck(usd, 8500).warning).toBe('That is ₹0.85 per USD, which looks unusual. Check the rupee amount on your card statement before creating.');
    expect(foreignAmountCheck(usd, 10000000).warning).toBeNull(); // ₹1,000 per USD: allowed edge
    expect(foreignAmountCheck(usd, 85000000).warning).toMatch(/^That is ₹8,500.00 per USD/); // typed 8,50,000 for 8,500
  });
});
