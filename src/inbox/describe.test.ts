import { planAction } from '../core/plan';
import { describeStep, stepTitle } from './describe';
import { BANK, CARD, txnFrom } from './testData';

const ctx = (account = BANK) => ({ company: 'ZP', account, drawingsAccount: 'Drawings - ZP', today: '2026-11-08' });

describe('describeStep (confirm screen rows)', () => {
  it('customer advance Payment Entry', () => {
    const t = txnFrom('idfc-006');
    const p = planAction(t, { type: 'customer_advance', party: { doctype: 'Customer', name: 'Acme' } }, ctx());
    expect(stepTitle(p.steps[0])).toBe('Payment Entry');
    expect(describeStep(p.steps[0])).toEqual([
      { label: 'Money in from', value: 'Acme (Customer)' },
      { label: 'Amount', value: '₹30,000.00', strong: true },
      { label: 'Into account', value: 'IDFC First - ZP' },
      { label: 'Mode of payment', value: 'Wire Transfer' },
      { label: 'Date', value: '5 Nov 2026' },
      { label: 'Reference', value: 'SBIN32974781', mono: true },
    ]);
  });
  it('customer advance for an order: plain words, no document type names', () => {
    const t = txnFrom('idfc-006'); // ₹30,000.00
    const party = { doctype: 'Customer' as const, name: 'Acme' };
    const one = planAction(t, { type: 'customer_advance', party, orders: [{ name: 'SAL-ORD-2026-2027-00004', allocatedMinor: 2_500_000 }] }, ctx());
    const rows = describeStep(one.steps[0]);
    const lines = rows.map((r) => `${r.label} ${r.value}`);
    expect(lines).toContain('Advance for order SAL-ORD-2026-2027-00004 (₹25,000.00)');
    expect(rows.slice(0, 3)).toEqual([
      { label: 'Money in from', value: 'Acme (Customer)' },
      { label: 'Amount', value: '₹30,000.00', strong: true },
      { label: 'Advance for', value: 'order SAL-ORD-2026-2027-00004 (₹25,000.00)' },
    ]);
    expect(rows.map((r) => r.label)).not.toContain('Against');
    for (const l of lines) {
      expect(l).not.toMatch(/Payment Entry/);
      expect(l).not.toMatch(/Sales Order/);
    }
    const two = planAction(t, {
      type: 'customer_advance', party, orders: [{ name: 'SO-1', allocatedMinor: 2_000_000 }, { name: 'SO-2', allocatedMinor: 500_000 }],
    }, ctx());
    expect(describeStep(two.steps[0])).toContainEqual({ label: 'Advance for', value: 'order SO-1 (₹20,000.00), order SO-2 (₹5,000.00)' });
  });
  it('customer advance without an order has no order line', () => {
    const p = planAction(txnFrom('idfc-006'), { type: 'customer_advance', party: { doctype: 'Customer', name: 'Acme' } }, ctx());
    expect(describeStep(p.steps[0]).map((r) => r.label)).not.toContain('Advance for');
  });
  it('payment against invoices lists them', () => {
    const t = txnFrom('idfc-010');
    const p = planAction(t, { type: 'against_invoice', party: { doctype: 'Supplier', name: 'Airtel' }, invoices: [{ doctype: 'Purchase Invoice', name: 'PI-1', allocatedMinor: 1000000 }] }, ctx());
    const rows = describeStep(p.steps[0]);
    expect(rows[0]).toEqual({ label: 'Paid to', value: 'Airtel (Supplier)' });
    expect(rows).toContainEqual({ label: 'From account', value: 'IDFC First - ZP' });
    expect(rows).toContainEqual({ label: 'Against', value: 'PI-1 (₹10,000.00)' });
  });
  it('internal transfer', () => {
    const p = planAction(txnFrom('idfc-010'), { type: 'transfer', toAccount: CARD }, ctx());
    const rows = describeStep(p.steps[0]);
    expect(rows.slice(0, 3)).toEqual([
      { label: 'From account', value: 'IDFC First - ZP' },
      { label: 'To account', value: 'IDFC Credit Card - ZP' },
      { label: 'Amount', value: '₹30,000.00', strong: true },
    ]);
  });
  it('expense Journal Entry: debit and credit rows', () => {
    const t = txnFrom('idfc-034');
    const p = planAction(t, { type: 'expense', expenseAccount: 'Advertising - ZP', party: { doctype: 'Supplier', name: 'Google' } }, ctx(CARD));
    expect(describeStep(p.steps[0])).toEqual([
      { label: 'Debit', value: 'Advertising - ZP (Google)' },
      { label: 'Credit', value: 'IDFC Credit Card - ZP' },
      { label: 'Amount', value: '₹10,333.79', strong: true },
      { label: 'Date', value: '4 Nov 2026' },
      { label: 'Reference', value: `AL-${t.rawHash}`, mono: true },
    ]);
  });
  it('new party', () => {
    const t = txnFrom('idfc-006');
    const p = planAction(t, { type: 'customer_advance', party: { doctype: 'Customer', name: 'Acme' } },
      { ...ctx(), newParty: { ref: { doctype: 'Customer', name: 'Acme' }, fields: { customer_name: 'Acme', customer_group: 'Commercial' } } });
    expect(stepTitle(p.steps[0])).toBe('New Customer');
    expect(describeStep(p.steps[0], { customer_group: 'Customer Group' })).toEqual([{ label: 'Name', value: 'Acme' }, { label: 'Customer Group', value: 'Commercial' }]);
    expect(describeStep(p.steps[0])).toEqual([{ label: 'Name', value: 'Acme' }, { label: 'Customer group', value: 'Commercial' }]);
  });
});
