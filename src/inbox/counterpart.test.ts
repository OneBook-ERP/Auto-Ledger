import { txnReference } from '../core/plan';
import type { PendingTxn } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { runPlan } from '../outbox/runner';
import { counterMappingOf, counterpartCandidates, findCounterpartLeg } from './counterpart';
import { fakeInboxErp } from './fakeErp';
import { planFor } from './flow';
import { submitAnswer } from './submit';
import { BANK, BANK2, CARD, smsTxn, txnFrom } from './testData';

// IDFC current (…6507) -> IDFC savings (…1111), ₹30,000. The debit leg carries a real UTR (long NEFT format);
// the credit leg is the short format with NO UTR, so its own reference is AL-<rawHash>.
const debitLeg = () => txnFrom('idfc-010');
const creditLeg = (afterMs = 120_000, amount = 'INR 30,000.00') =>
  smsTxn('idfc-001', [['XXXXX996507', 'XXXXX991111'], ['INR 12,932.00', amount], ['02/09/26 09:13', '19/10/26 10:05']], debitLeg().receivedAt + afterMs);
const MAPPINGS = [BANK, BANK2, CARD];
const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-10-20' };
const fromBank = { bankAccount: BANK.bankAccount, glAccount: BANK.glAccount, modeOfPayment: BANK.modeOfPayment };

/** A fake ERPNext that stores drafts and finds them by reference, like the real one. */
function statefulErp() {
  const erp = fakeInboxErp();
  const docs: { doctype: string; name: string; body: Record<string, unknown> }[] = [];
  erp.createDraft.mockImplementation(async (doctype, body) => {
    const name = `ACC-PAY-${String(docs.length + 1).padStart(4, '0')}`;
    docs.push({ doctype, name, body });
    return { name };
  });
  erp.findDraftByUtr.mockImplementation(async (ref) => {
    const d = docs.find((x) => x.body.reference_no === ref || x.body.cheque_no === ref);
    return d ? { doctype: d.doctype, name: d.name, docstatus: 0 } : null;
  });
  return { erp, docs };
}

async function answer(repo: Repo, erp: ReturnType<typeof statefulErp>['erp'], t: PendingTxn) {
  const debit = t.direction === 'out';
  const counter = debit ? BANK2 : BANK;
  const link = await findCounterpartLeg(t, counter, repo, MAPPINGS);
  const d = debit ? { mapping: BANK, action: 'transfer' as const, toAccount: BANK2 } : { mapping: BANK2, action: 'transfer' as const, fromAccount: fromBank };
  const { plan, choice } = planFor(t, d, settings, link.status === 'linked' ? { referenceOverride: link.reference } : {});
  const o = await submitAnswer({ repo, erp, runPlan }, { txn: t, plan, choice, remember: false });
  return { link, plan, o };
}

async function world(txns: PendingTxn[]) {
  const repo = await createRepo(createTestDriver());
  for (const m of MAPPINGS) await repo.saveMapping(m);
  for (const t of txns) await repo.upsertPending(t);
  return { repo, ...statefulErp() };
}

describe('the fixtures behave as the scenario needs', () => {
  it('credit leg: savings, no UTR; debit leg: current, real UTR; same amount', () => {
    const c = creditLeg();
    const d = debitLeg();
    expect([c.direction, c.accountLast4, c.utr, c.amountMinor]).toEqual(['in', '1111', null, 3000000]);
    expect([d.direction, d.accountLast4, d.utr, d.amountMinor]).toEqual(['out', '6507', 'IDFB6292M4509651', 3000000]);
    expect(txnReference(c)).toBe(`AL-${c.rawHash}`);
  });
});

describe('own-account transfer read on both accounts: booked once (R54)', () => {
  it('debit first, then credit: the credit leg links to the debit leg and adopts its Payment Entry', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, c]);
    const first = await answer(repo, erp, d);
    expect(first.link).toEqual({ status: 'none' }); // nothing recorded yet
    expect(first.o.kind).toBe('created');
    const second = await answer(repo, erp, c);
    expect(second.link).toEqual({ status: 'linked', reference: 'IDFB6292M4509651', txnId: d.id, docName: 'ACC-PAY-0001', counterLabel: 'IDFC First' });
    expect(second.plan.steps[0].body).toMatchObject({ reference_no: 'IDFB6292M4509651', paid_from: 'IDFC First - ZP', paid_to: 'IDFC Savings - ZP' });
    expect(second.o).toEqual({ kind: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(docs).toHaveLength(1);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    expect((await repo.getPending(c.id))).toMatchObject({ state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }] });
    // the two legs' plans are equivalent documents (what an adoption equivalence check compares)
    const pick = (b: Record<string, unknown>) => [b.payment_type, b.paid_from, b.paid_to, b.paid_amount];
    expect(pick(second.plan.steps[0].body)).toEqual(pick(docs[0].body));
  });

  it('credit first, then debit: the debit leg links to the credit leg (AL- reference) and adopts', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, c]);
    expect((await answer(repo, erp, c)).link).toEqual({ status: 'none' });
    expect(docs[0].body.reference_no).toBe(`AL-${c.rawHash}`);
    const second = await answer(repo, erp, d);
    expect(second.link).toMatchObject({ status: 'linked', reference: `AL-${c.rawHash}`, txnId: c.id, counterLabel: 'IDFC Savings' });
    expect(second.o).toEqual({ kind: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    expect((await repo.getPending(d.id))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }]);
  });

  it('a second leg 5 days later is not linked (and books its own entry)', async () => {
    const d = debitLeg();
    const c = creditLeg(5 * 86_400_000);
    const { repo, erp, docs } = await world([d, c]);
    await answer(repo, erp, d);
    expect((await answer(repo, erp, c)).link).toEqual({ status: 'none' });
    expect(docs).toHaveLength(2);
  });

  it('a different amount is not linked', async () => {
    const d = debitLeg();
    const c = creditLeg(120_000, 'INR 29,999.00');
    const { repo, erp } = await world([d, c]);
    await answer(repo, erp, d);
    expect((await answer(repo, erp, c)).link).toEqual({ status: 'none' });
  });

  it('two candidates: a warning, no link', async () => {
    const d = debitLeg();
    const d2 = { ...d, id: 't_other', rawHash: 'other', receivedAt: d.receivedAt + 1000 };
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, d2, c]);
    await answer(repo, erp, d);
    // the second debit was booked by hand elsewhere, recorded as created with a Payment Entry
    await repo.upsertPending({ ...d2, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0099', docstatus: 0 }] });
    const second = await answer(repo, erp, c);
    expect(second.link).toEqual({ status: 'several', count: 2 });
    expect(second.plan.steps[0].body.reference_no).toBe(`AL-${c.rawHash}`);
    expect(docs).toHaveLength(2);
  });

  it('an unmapped counter account is not searched at all', async () => {
    const repo = await createRepo(createTestDriver());
    const spy = jest.spyOn(repo, 'listPending');
    expect(await findCounterpartLeg(creditLeg(), null, repo, MAPPINGS)).toEqual({ status: 'none' });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('counterpartCandidates (pure)', () => {
  const d = { ...debitLeg(), state: 'created' as const, createdDocs: [{ doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 }] };
  const c = creditLeg();
  it('matches opposite direction, INR, equal amount, within 3 days, on the counter mapping, with a Payment Entry', () => {
    expect(counterpartCandidates(c, BANK, [d], MAPPINGS).map((x) => x.id)).toEqual([d.id]);
  });
  it.each([
    ['same direction', { direction: 'in' as const }],
    ['still new', { state: 'new' as const }],
    ['ignored', { state: 'ignored' as const }],
    ['no Payment Entry', { createdDocs: [{ doctype: 'Journal Entry', name: 'JV-1', docstatus: 0 }] }],
    ['foreign', { currency: 'USD' }],
    ['other amount', { amountMinor: 3000001 }],
    ['3 days + 1 ms', { receivedAt: c.receivedAt - 3 * 86_400_000 - 1 }],
    ['other account', { accountLast4: '9999' }],
  ])('not: %s', (_n, over) => {
    expect(counterpartCandidates(c, BANK, [{ ...d, ...over } as PendingTxn], MAPPINGS)).toEqual([]);
  });
  it('submitted counts; exactly 3 days counts; the txn itself never counts', () => {
    expect(counterpartCandidates(c, BANK, [{ ...d, state: 'submitted', receivedAt: c.receivedAt - 3 * 86_400_000 }], MAPPINGS)).toHaveLength(1);
    expect(counterpartCandidates(c, BANK2, [{ ...c, state: 'created', createdDocs: d.createdDocs }], MAPPINGS)).toEqual([]);
  });
});

describe('counterMappingOf', () => {
  it('debit: the toAccount; credit: the mapping of the source, null when the source is not read', () => {
    expect(counterMappingOf({ action: 'transfer', toAccount: BANK2 }, 'out', MAPPINGS)).toBe(BANK2);
    expect(counterMappingOf({ action: 'transfer', fromAccount: { bankAccount: BANK.bankAccount } }, 'in', MAPPINGS)).toBe(BANK);
    expect(counterMappingOf({ action: 'transfer', fromAccount: { bankAccount: 'ICICI Savings - ZP' } }, 'in', MAPPINGS)).toBeNull();
    expect(counterMappingOf({ action: 'expense' }, 'out', MAPPINGS)).toBeNull();
  });
  it('the override is used for transfers only', () => {
    const { plan } = planFor(debitLeg(), { mapping: BANK, action: 'personal' }, settings, { referenceOverride: 'X' });
    expect(plan.steps[0].body.cheque_no).toBe('IDFB6292M4509651');
  });
});
