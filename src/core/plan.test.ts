import fixtures from '../../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from './parser';
import { minorToMajor, planAction, PlanError, txnReference } from './plan';
import type { PlanContext } from './plan';
import type { AccountMapping, ActionChoice, ParsedTxn, PendingTxn } from './types';

function parsed(id: string): ParsedTxn {
  const f = (fixtures as { id: string; sender: string; body: string; receivedAt: number }[]).find((x) => x.id === id)!;
  const r = parseSms(f.sender, f.body, f.receivedAt, bundledTemplates);
  if (!r.ok) throw new Error(`fixture ${id} did not parse`);
  return r.txn;
}
function pending(t: ParsedTxn): PendingTxn {
  return { ...t, id: 'p1', mergedCount: 1, state: 'new', createdDocs: [], error: null };
}
const bank: AccountMapping = {
  bankAccount: 'IDFC CA', glAccount: 'IDFC First - ZP', kind: 'bank', senderIds: [], last4: ['6507'], modeOfPayment: 'Current Account Bank Entry',
};
const card: AccountMapping = {
  bankAccount: 'IDFC Card', glAccount: 'IDFC Credit Card - ZP', kind: 'card', senderIds: [], last4: ['3455'], modeOfPayment: 'Credit Card Bank Entry',
};
const acme = { doctype: 'Customer', name: 'Acme Test Traders' } as const;
const airtel = { doctype: 'Supplier', name: 'Bharti Airtel Limited' } as const;
const staff = { doctype: 'Employee', name: 'HR-EMP-00001' } as const;

function ctxFor(t: ParsedTxn, account: AccountMapping, extra: Partial<PlanContext> = {}): PlanContext {
  return { company: 'Zeta', account, drawingsAccount: 'Drawings - ZP', today: t.occurredOn, ...extra };
}
function run(id: string, account: AccountMapping, choice: ActionChoice, extra: Partial<PlanContext> = {}) {
  const t = pending(parsed(id));
  const plan = planAction(t, choice, ctxFor(t, account, extra));
  return { t, plan, doc: plan.steps[plan.steps.length - 1]?.body as Record<string, any> };
}

describe('minorToMajor', () => {
  it.each([[1, 0.01], [100, 1], [1293200, 12932], [51293276, 512932.76], [7894853, 78948.53], [0, 0], [5, 0.05]])('%d -> %d', (m, v) => {
    expect(minorToMajor(m)).toBe(v);
  });
  it('rejects non-integers and negatives', () => {
    expect(() => minorToMajor(1.5)).toThrow();
    expect(() => minorToMajor(-1)).toThrow();
  });
});

describe('txnReference', () => {
  it('uses the utr, else AL- + rawHash', () => {
    expect(txnReference(parsed('idfc-006'))).toBe('SBIN32974781');
    const t = parsed('idfc-001');
    expect(txnReference(t)).toBe('AL-' + t.rawHash);
  });
});

describe('planAction rows', () => {
  it('customer_advance: PE Receive, unallocated', () => {
    const { t, plan, doc } = run('idfc-006', bank, { type: 'customer_advance', party: acme });
    expect(plan.needsInrAmount).toBe(false);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe('create_doc');
    expect(plan.steps[0].doctype).toBe('Payment Entry');
    expect(doc).toMatchObject({
      company: 'Zeta', posting_date: t.occurredOn, payment_type: 'Receive', party_type: 'Customer', party: 'Acme Test Traders',
      mode_of_payment: 'Current Account Bank Entry', paid_to: 'IDFC First - ZP', reference_no: 'SBIN32974781', reference_date: t.occurredOn,
      paid_amount: minorToMajor(t.amountMinor), received_amount: minorToMajor(t.amountMinor),
    });
    expect(doc.references).toBeUndefined();
    expect(plan.summary.join(' ')).toContain('Payment Entry (draft)');
    expect(plan.summary.join(' ')).toContain('Acme Test Traders');
    expect(plan.summary.join(' ')).toContain('SBIN32974781');
  });

  it('customer_advance without utr uses AL- hash; summary has Indian grouping', () => {
    const { t, plan, doc } = run('idfc-001', bank, { type: 'customer_advance', party: acme });
    expect(doc.reference_no).toBe('AL-' + t.rawHash);
    expect(doc.paid_amount).toBe(12932);
    expect(plan.summary.join(' ')).toContain('₹12,932.00');
  });

  it('indian grouping above a lakh', () => {
    const t = pending({ ...parsed('idfc-006'), amountMinor: 51293276 });
    const plan = planAction(t, { type: 'customer_advance', party: acme }, ctxFor(t, bank));
    expect(plan.summary.join(' ')).toContain('₹5,12,932.76');
  });

  describe('customer_advance with Sales Orders', () => {
    const adv = () => pending({ ...parsed('idfc-006'), amountMinor: 2_500_000 });
    it('customer_advance with one order adds a Sales Order reference', () => {
      const t = adv();
      const plan = planAction(t, {
        type: 'customer_advance', party: acme, orders: [{ name: 'SAL-ORD-2026-2027-00004', allocatedMinor: 2_500_000 }],
      }, ctxFor(t, bank));
      const doc = plan.steps[plan.steps.length - 1].body as Record<string, any>;
      expect(doc).toMatchObject({ payment_type: 'Receive', party_type: 'Customer', party: acme.name, paid_amount: 25000 });
      expect(doc.references).toEqual([{ reference_doctype: 'Sales Order', reference_name: 'SAL-ORD-2026-2027-00004', allocated_amount: 25000 }]);
      expect(plan.summary.join(' ')).toContain('for order SAL-ORD-2026-2027-00004');
    });
    it('customer_advance without orders is unchanged', () => {
      const t = adv();
      const doc = planAction(t, { type: 'customer_advance', party: acme }, ctxFor(t, bank)).steps[0].body;
      expect('references' in doc).toBe(false);
    });
    it('customer_advance over-allocated throws PlanError(\'over_allocated\')', () => {
      const t = adv();
      const choice: ActionChoice = {
        type: 'customer_advance', party: acme,
        orders: [{ name: 'SO-1', allocatedMinor: 2_000_000 }, { name: 'SO-2', allocatedMinor: 500_001 }],
      };
      expect(() => planAction(t, choice, ctxFor(t, bank))).toThrow(PlanError);
      expect(() => planAction(t, choice, ctxFor(t, bank))).toThrow(expect.objectContaining({ code: 'over_allocated' }));
    });
    it('customer_advance split over two orders sums to at most the payment', () => {
      const t = adv();
      const plan = planAction(t, {
        type: 'customer_advance', party: acme,
        orders: [{ name: 'SO-1', allocatedMinor: 2_000_000 }, { name: 'SO-2', allocatedMinor: 500_000 }],
      }, ctxFor(t, bank));
      expect((plan.steps[0].body as Record<string, any>).references).toEqual([
        { reference_doctype: 'Sales Order', reference_name: 'SO-1', allocated_amount: 20000 },
        { reference_doctype: 'Sales Order', reference_name: 'SO-2', allocated_amount: 5000 },
      ]);
      expect(plan.summary.join(' ')).toContain('for orders SO-1 (₹20,000.00), SO-2 (₹5,000.00)');
    });
    it('customer_advance with an empty orders array behaves like no orders', () => {
      const t = adv();
      const a = planAction(t, { type: 'customer_advance', party: acme, orders: [] }, ctxFor(t, bank));
      const b = planAction(t, { type: 'customer_advance', party: acme }, ctxFor(t, bank));
      expect(a).toEqual(b);
      expect('references' in a.steps[0].body).toBe(false);
    });
  });

  it('supplier_payment: PE Pay, Supplier, paid_from = account', () => {
    const { t, doc } = run('idfc-010', bank, { type: 'supplier_payment', party: airtel });
    expect(doc).toMatchObject({
      payment_type: 'Pay', party_type: 'Supplier', party: airtel.name, paid_from: 'IDFC First - ZP',
      mode_of_payment: 'Current Account Bank Entry', reference_no: t.utr, reference_date: t.occurredOn, paid_amount: minorToMajor(t.amountMinor),
    });
    expect(doc.references).toBeUndefined();
  });

  it('against_invoice Sales Invoice: Receive with references, partial allowed', () => {
    const { doc } = run('idfc-006', bank, {
      type: 'against_invoice', party: acme, invoices: [{ doctype: 'Sales Invoice', name: 'SI-1', allocatedMinor: 100000 }],
    });
    expect(doc).toMatchObject({ payment_type: 'Receive', party_type: 'Customer', paid_to: 'IDFC First - ZP' });
    expect(doc.references).toEqual([{ reference_doctype: 'Sales Invoice', reference_name: 'SI-1', allocated_amount: 1000 }]);
  });

  it('against_invoice Purchase Invoice: Pay, multiple rows', () => {
    const { doc } = run('idfc-010', bank, {
      type: 'against_invoice', party: airtel,
      invoices: [{ doctype: 'Purchase Invoice', name: 'PINV-1', allocatedMinor: 100 }, { doctype: 'Purchase Invoice', name: 'PINV-2', allocatedMinor: 250 }],
    });
    expect(doc).toMatchObject({ payment_type: 'Pay', party_type: 'Supplier', paid_from: 'IDFC First - ZP' });
    expect(doc.references).toEqual([
      { reference_doctype: 'Purchase Invoice', reference_name: 'PINV-1', allocated_amount: 1 },
      { reference_doctype: 'Purchase Invoice', reference_name: 'PINV-2', allocated_amount: 2.5 },
    ]);
  });

  it('against_invoice rejects over-allocation and mixed doctypes', () => {
    const t = pending(parsed('idfc-006'));
    const c = ctxFor(t, bank);
    expect(() => planAction(t, { type: 'against_invoice', party: acme, invoices: [{ doctype: 'Sales Invoice', name: 'S', allocatedMinor: t.amountMinor + 1 }] }, c))
      .toThrow(expect.objectContaining({ code: 'over_allocated' }));
    expect(() => planAction(t, { type: 'against_invoice', party: acme, invoices: [
      { doctype: 'Sales Invoice', name: 'S', allocatedMinor: 1 }, { doctype: 'Purchase Invoice', name: 'P', allocatedMinor: 1 }] }, c))
      .toThrow(expect.objectContaining({ code: 'mixed_invoices' }));
  });

  it('bill_paid_by_card: PE Pay from card liability with a reference row', () => {
    const { t, doc } = run('idfc-025', card, { type: 'bill_paid_by_card', party: airtel, invoice: { name: 'PINV-9', allocatedMinor: parsed('idfc-025').amountMinor } });
    expect(doc).toMatchObject({
      payment_type: 'Pay', party_type: 'Supplier', party: airtel.name, paid_from: 'IDFC Credit Card - ZP',
      mode_of_payment: 'Credit Card Bank Entry', reference_no: txnReference(t), reference_date: t.occurredOn,
    });
    expect(doc.references).toEqual([{ reference_doctype: 'Purchase Invoice', reference_name: 'PINV-9', allocated_amount: minorToMajor(t.amountMinor) }]);
  });

  it('expense on card: JE debit expense, credit card GL, cheque_no/date', () => {
    const { t, plan, doc } = run('idfc-025', card, { type: 'expense', expenseAccount: 'Software - ZP' });
    expect(plan.steps[0].doctype).toBe('Journal Entry');
    const amt = minorToMajor(t.amountMinor);
    expect(doc).toMatchObject({ company: 'Zeta', posting_date: t.occurredOn, voucher_type: 'Journal Entry', cheque_no: txnReference(t), cheque_date: t.occurredOn });
    expect(doc.accounts).toEqual([
      { account: 'Software - ZP', debit_in_account_currency: amt },
      { account: 'IDFC Credit Card - ZP', credit_in_account_currency: amt },
    ]);
  });

  it('expense with a supplier party puts party on the debit row', () => {
    const { doc } = run('idfc-025', card, { type: 'expense', expenseAccount: 'Software - ZP', party: airtel });
    expect(doc.accounts[0]).toMatchObject({ account: 'Software - ZP', party_type: 'Supplier', party: airtel.name });
    expect(doc.accounts[1].party).toBeUndefined();
  });

  it('salary: PE Pay to Employee', () => {
    const { doc } = run('idfc-010', bank, { type: 'salary', party: staff });
    expect(doc).toMatchObject({ payment_type: 'Pay', party_type: 'Employee', party: 'HR-EMP-00001', paid_from: 'IDFC First - ZP', mode_of_payment: 'Current Account Bank Entry' });
  });

  it('other_income: JE debit bank, credit income', () => {
    const { t, doc } = run('idfc-006', bank, { type: 'other_income', incomeAccount: 'Interest Income - ZP' });
    const amt = minorToMajor(t.amountMinor);
    expect(doc.accounts).toEqual([
      { account: 'IDFC First - ZP', debit_in_account_currency: amt },
      { account: 'Interest Income - ZP', credit_in_account_currency: amt },
    ]);
    expect(doc).toMatchObject({ cheque_no: 'SBIN32974781', cheque_date: t.occurredOn });
  });

  it('transfer: Internal Transfer from this account to the card, source mode of payment', () => {
    const { t, doc } = run('idfc-010', bank, { type: 'transfer', toAccount: card });
    expect(doc).toMatchObject({
      payment_type: 'Internal Transfer', paid_from: 'IDFC First - ZP', paid_to: 'IDFC Credit Card - ZP',
      mode_of_payment: 'Current Account Bank Entry', reference_no: t.utr, reference_date: t.occurredOn,
      paid_amount: minorToMajor(t.amountMinor), received_amount: minorToMajor(t.amountMinor),
    });
    expect(doc.party).toBeUndefined();
  });

  it('personal out: debit drawings, credit bank; in: reversed', () => {
    const out = run('idfc-010', bank, { type: 'personal' });
    const amt = minorToMajor(out.t.amountMinor);
    expect(out.doc.accounts).toEqual([
      { account: 'Drawings - ZP', debit_in_account_currency: amt },
      { account: 'IDFC First - ZP', credit_in_account_currency: amt },
    ]);
    const inn = run('idfc-006', bank, { type: 'personal' });
    const a2 = minorToMajor(inn.t.amountMinor);
    expect(inn.doc.accounts).toEqual([
      { account: 'IDFC First - ZP', debit_in_account_currency: a2 },
      { account: 'Drawings - ZP', credit_in_account_currency: a2 },
    ]);
    expect(inn.doc.cheque_no).toBe('SBIN32974781');
  });

  it('ignore: no steps, even for a stale date', () => {
    const t = pending(parsed('idfc-006'));
    const plan = planAction(t, { type: 'ignore' }, { ...ctxFor(t, bank), today: '2030-01-01' });
    expect(plan.steps).toEqual([]);
    expect(plan.needsInrAmount).toBe(false);
  });
});

describe('foreign currency', () => {
  it('needs the INR amount first', () => {
    const t = pending(parsed('idfc-039'));
    expect(t.currency).toBe('USD');
    const plan = planAction(t, { type: 'expense', expenseAccount: 'Software - ZP' }, ctxFor(t, card));
    expect(plan.needsInrAmount).toBe(true);
    expect(plan.steps).toEqual([]);
    expect(plan.summary.length).toBeGreaterThan(0);
  });
  it('uses the INR value and notes the USD amount in remarks', () => {
    const t = pending(parsed('idfc-039'));
    const plan = planAction(t, { type: 'expense', expenseAccount: 'Software - ZP' }, ctxFor(t, card, { inrAmountMinor: 842050 }));
    const doc = plan.steps[0].body as Record<string, any>;
    expect(plan.needsInrAmount).toBe(false);
    expect(doc.accounts[0].debit_in_account_currency).toBe(8420.5);
    expect(doc.accounts[1].credit_in_account_currency).toBe(8420.5);
    expect(doc.user_remark).toContain('USD');
    expect(doc.user_remark).toContain(String(Math.floor(t.amountMinor / 100)));
    expect(plan.summary.join(' ')).toContain('₹8,420.50');
  });
  it('PE carries remarks', () => {
    const t = pending({ ...parsed('idfc-039'), direction: 'out' });
    const plan = planAction(t, { type: 'supplier_payment', party: airtel }, ctxFor(t, card, { inrAmountMinor: 100 }));
    expect((plan.steps[0].body as any).remarks).toContain('USD');
    expect((plan.steps[0].body as any).paid_amount).toBe(1);
  });
});

describe('PlanError', () => {
  const t = pending(parsed('idfc-006'));
  const catchCode = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(PlanError); return (e as PlanError).code; } return 'none'; };
  const at = (today: string) => ({ ...ctxFor(t, bank), today });
  const day = (offset: number) => {
    const d = new Date(Date.parse(t.occurredOn + 'T00:00:00Z') + offset * 86400000);
    return d.toISOString().slice(0, 10);
  };
  const choice: ActionChoice = { type: 'customer_advance', party: acme };

  it('date boundaries', () => {
    expect(catchCode(() => planAction(t, choice, at(day(-1))))).toBe('none'); // occurred 1 day after today: ok
    expect(catchCode(() => planAction(t, choice, at(day(-2))))).toBe('date_out_of_range');
    expect(catchCode(() => planAction(t, choice, at(day(400))))).toBe('none'); // exactly 400 days before: ok
    expect(catchCode(() => planAction(t, choice, at(day(401))))).toBe('date_out_of_range');
  });

  it('bad_direction', () => {
    const out = pending(parsed('idfc-010'));
    const oc = ctxFor(out, bank);
    const inn = ctxFor(t, bank);
    expect(catchCode(() => planAction(out, choice, oc))).toBe('bad_direction');
    expect(catchCode(() => planAction(out, { type: 'against_invoice', party: acme, invoices: [{ doctype: 'Sales Invoice', name: 'S', allocatedMinor: 1 }] }, oc))).toBe('bad_direction');
    expect(catchCode(() => planAction(out, { type: 'other_income', incomeAccount: 'X' }, oc))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'supplier_payment', party: airtel }, inn))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'salary', party: staff }, inn))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'expense', expenseAccount: 'X' }, inn))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'bill_paid_by_card', party: airtel, invoice: { name: 'P', allocatedMinor: 1 } }, inn))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'transfer', toAccount: card }, inn))).toBe('bad_direction');
    expect(catchCode(() => planAction(t, { type: 'against_invoice', party: airtel, invoices: [{ doctype: 'Purchase Invoice', name: 'P', allocatedMinor: 1 }] }, inn))).toBe('bad_direction');
  });

  it('transfer to the same account is rejected', () => {
    const out = pending(parsed('idfc-010'));
    expect(catchCode(() => planAction(out, { type: 'transfer', toAccount: bank }, ctxFor(out, bank)))).toBe('same_account');
  });
});

describe('credit transfer (R52b: fromAccount, money in only)', () => {
  const catchCode = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(PlanError); return (e as PlanError).code; } return 'none'; };
  const icici = { bankAccount: 'ICICI Savings', glAccount: 'ICICI - ZP', modeOfPayment: 'Wire Transfer' };
  it('Internal Transfer Payment Entry from the other account into this one', () => {
    const { t, plan, doc } = run('idfc-006', bank, { type: 'transfer', fromAccount: icici });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ kind: 'create_doc', doctype: 'Payment Entry' });
    expect(doc).toEqual({
      company: 'Zeta', posting_date: t.occurredOn, mode_of_payment: 'Wire Transfer',
      paid_amount: minorToMajor(t.amountMinor), received_amount: minorToMajor(t.amountMinor),
      reference_no: 'SBIN32974781', reference_date: t.occurredOn, remarks: 'AutoLedger | COMPANY_11',
      payment_type: 'Internal Transfer', paid_from: 'ICICI - ZP', paid_to: 'IDFC First - ZP',
    });
    expect(plan.summary).toEqual([`Internal transfer: ₹30,000.00 from ICICI - ZP into IDFC First - ZP, UTR/ref SBIN32974781, ${t.occurredOn}`]);
  });
  it('mode of payment falls back to this account\'s', () => {
    const { doc } = run('idfc-006', bank, { type: 'transfer', fromAccount: { bankAccount: 'ICICI Savings', glAccount: 'ICICI - ZP' } });
    expect(doc.mode_of_payment).toBe('Current Account Bank Entry');
  });
  it('the outgoing form now also says Internal transfer', () => {
    const { t, plan } = run('idfc-010', bank, { type: 'transfer', toAccount: card });
    expect(plan.summary[0]).toBe(`Internal transfer: ₹30,000.00 from IDFC First - ZP into IDFC Credit Card - ZP, UTR/ref ${t.utr}, ${t.occurredOn}`);
  });
  it('bad_direction both ways; same_account', () => {
    const inn = pending(parsed('idfc-006'));
    const out = pending(parsed('idfc-010'));
    expect(catchCode(() => planAction(inn, { type: 'transfer', toAccount: card }, ctxFor(inn, bank)))).toBe('bad_direction');
    expect(catchCode(() => planAction(out, { type: 'transfer', fromAccount: icici }, ctxFor(out, bank)))).toBe('bad_direction');
    expect(catchCode(() => planAction(inn, { type: 'transfer', fromAccount: { bankAccount: 'IDFC CA', glAccount: 'IDFC First - ZP' } }, ctxFor(inn, bank)))).toBe('same_account');
  });
});

describe('referenceOverride (R54)', () => {
  it('replaces the reference on a Payment Entry and a Journal Entry; the summary names it', () => {
    const { doc, plan } = run('idfc-001', bank, { type: 'transfer', fromAccount: { bankAccount: 'IDFC Savings', glAccount: 'Sav - ZP' } }, { referenceOverride: 'IDFB6292M4509651' });
    expect(doc.reference_no).toBe('IDFB6292M4509651');
    expect(plan.summary[0]).toContain('UTR/ref IDFB6292M4509651');
    const je = run('idfc-001', bank, { type: 'personal' }, { referenceOverride: 'X-1' });
    expect(je.doc.cheque_no).toBe('X-1');
  });
  it('absent or blank: txnReference as before', () => {
    const t = parsed('idfc-001');
    expect(run('idfc-001', bank, { type: 'personal' }, { referenceOverride: ' ' }).doc.cheque_no).toBe('AL-' + t.rawHash);
    expect(run('idfc-001', bank, { type: 'personal' }).doc.cheque_no).toBe('AL-' + t.rawHash);
  });
});

describe('bad_date (R35)', () => {
  const bads = ['2026-02-31', '2026-13-01', '2026-11', 'not-a-date'];
  const t = pending(parsed('idfc-006'));
  const choice: ActionChoice = { type: 'customer_advance', party: acme };
  it.each(bads)('occurredOn %s', (d) => {
    expect(() => planAction({ ...t, occurredOn: d }, choice, { ...ctxFor(t, bank), today: '2026-11-08' })).toThrow(expect.objectContaining({ code: 'bad_date' }));
  });
  it.each(bads)('today %s', (d) => {
    expect(() => planAction(t, choice, { ...ctxFor(t, bank), today: d })).toThrow(expect.objectContaining({ code: 'bad_date' }));
  });
  it('ignore returns before the date check', () => {
    expect(planAction({ ...t, occurredOn: 'not-a-date' }, { type: 'ignore' }, { ...ctxFor(t, bank), today: 'x' }).steps).toEqual([]);
  });
});

describe('live-verified ERPNext behaviour (stage, Task 12 check, spike B.14)', () => {
  // Live on stage: a Pay Payment Entry WITHOUT paid_to was accepted as a draft; the server filled
  // paid_to = Creditors - ZP for a Supplier and Payroll Payable - ZP for an Employee. So the planner omits paid_to.
  it('Pay entries omit paid_to (server fills the party payable account)', () => {
    for (const [c, id] of [[{ type: 'supplier_payment', party: airtel }, 'idfc-010'], [{ type: 'salary', party: staff }, 'idfc-010']] as const) {
      expect(run(id, bank, c).doc).not.toHaveProperty('paid_to');
    }
  });
  // Live on stage: a Journal Entry with party_type/party on the expense debit row was accepted and kept.
  it('expense with a party keeps party_type/party on the debit row', () => {
    const { doc } = run('idfc-025', card, { type: 'expense', expenseAccount: 'Software - ZP', party: airtel });
    expect(doc.accounts[0]).toMatchObject({ party_type: 'Supplier', party: airtel.name });
  });
});

describe('new party (R34)', () => {
  it('prepends create_party when newParty equals the choice party', () => {
    const t = pending(parsed('idfc-006'));
    const fields = { customer_name: 'Acme Test Traders', customer_type: 'Company' };
    const plan = planAction(t, { type: 'customer_advance', party: acme }, ctxFor(t, bank, { newParty: { ref: acme, fields } }));
    expect(plan.steps.map((s) => [s.kind, s.doctype])).toEqual([['create_party', 'Customer'], ['create_doc', 'Payment Entry']]);
    expect(plan.steps[0].body).toEqual(fields);
    expect(plan.summary).toHaveLength(2);
    expect(plan.summary[0]).toContain('Acme Test Traders');
  });
  it('does not when the party differs', () => {
    const t = pending(parsed('idfc-006'));
    const plan = planAction(t, { type: 'customer_advance', party: acme }, ctxFor(t, bank, { newParty: { ref: { doctype: 'Customer', name: 'Other' }, fields: {} } }));
    expect(plan.steps).toHaveLength(1);
  });
});
