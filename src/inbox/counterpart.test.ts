import { txnReference } from '../core/plan';
import type { AccountMapping, PendingTxn } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpNetworkError } from '../erp/client';
import { drainOutbox } from '../ingest/drain';
import { runPlan } from '../outbox/runner';
import { counterMappingOf, counterpartCandidates, findCounterpartLeg, transferLegOf } from './counterpart';
import { fakeInboxErp, summaryOf } from './fakeErp';
import { planFor, type FlowDraft } from './flow';
import { submitAnswer } from './submit';
import { BANK, BANK2, CARD, smsTxn, txnFrom } from './testData';

// IDFC current (…6507, BANK) -> IDFC savings (…1111, BANK2), ₹30,000. The debit leg carries a real UTR (long
// NEFT format); the credit leg is the short format with NO UTR, so its own reference is AL-<rawHash>.
const debitLeg = () => txnFrom('idfc-010');
const T0 = txnFrom('idfc-010').receivedAt;
const creditLeg = (afterMs = 120_000, amount = 'INR 30,000.00', time = '10:05') =>
  smsTxn('idfc-001', [['XXXXX996507', 'XXXXX991111'], ['INR 12,932.00', amount], ['02/09/26 09:13', `19/10/26 ${time}`]], T0 + afterMs);
/** A second, equal transfer from current to savings with its own UTR. */
const debitLeg2 = () => smsTxn('idfc-010', [['IDFB6292M4509651', 'IDFB6292M4509999']], T0 + 3_600_000);
const creditLeg2 = () => creditLeg(3_700_000, 'INR 30,000.00', '11:05');
/** A third read account (for the three-account case). */
const BANK3: AccountMapping = { bankAccount: 'IDFC Payroll - ZP', glAccount: 'IDFC Payroll - ZP', kind: 'bank', senderIds: ['IDFCFB'], last4: ['2222'], modeOfPayment: 'Wire Transfer' };
const MAPPINGS = [BANK, BANK2, CARD, BANK3];
const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-10-20' };
const from = (m: AccountMapping) => ({ bankAccount: m.bankAccount, glAccount: m.glAccount, modeOfPayment: m.modeOfPayment });
const fromBank = from(BANK);
const toSavings: FlowDraft = { mapping: BANK, action: 'transfer', toAccount: BANK2 };
const intoSavings: FlowDraft = { mapping: BANK2, action: 'transfer', fromAccount: fromBank };

/** A fake ERPNext that stores drafts and finds them by reference (earliest first), like the real one. */
function statefulErp() {
  const erp = fakeInboxErp();
  const docs: { doctype: string; name: string; body: Record<string, unknown> }[] = [];
  erp.createDraft.mockImplementation(async (doctype, body) => {
    const name = `ACC-PAY-${String(docs.length + 1).padStart(4, '0')}`;
    docs.push({ doctype, name, body });
    return { name };
  });
  erp.findDraftsByUtr.mockImplementation(async (ref) =>
    docs.filter((x) => x.body.reference_no === ref || x.body.cheque_no === ref).map((d) => ({ doctype: d.doctype, name: d.name, docstatus: 0 })));
  erp.getDraftSummary.mockImplementation(async (doctype, name) => summaryOf(doctype, name, docs.find((x) => x.name === name)?.body ?? {}));
  erp.checkSession.mockResolvedValue(true);
  return { erp, docs };
}
type Erp = ReturnType<typeof statefulErp>['erp'];

/** Answers `t` like the Confirm screen: own plan, counterpart lookup, plan with the override, submit. */
async function answerWith(repo: Repo, erp: Erp, t: PendingTxn, d: FlowDraft) {
  const own = planFor(t, d, settings).plan;
  const counter = counterMappingOf(d, t.direction, MAPPINGS);
  const link = await findCounterpartLeg(t, counter, own, repo, MAPPINGS);
  const { plan, choice } = planFor(t, d, settings, link.status === 'linked' ? { referenceOverride: link.reference } : {});
  const o = await submitAnswer({ repo, erp, runPlan }, { txn: t, plan, choice, remember: false });
  return { link, plan, o };
}
const answer = (repo: Repo, erp: Erp, t: PendingTxn) => answerWith(repo, erp, t, t.direction === 'out' ? toSavings : intoSavings);

async function world(txns: PendingTxn[]) {
  const repo = await createRepo(createTestDriver());
  for (const m of MAPPINGS) await repo.saveMapping(m);
  for (const t of txns) await repo.upsertPending(t);
  return { repo, ...statefulErp() };
}
const docOf = async (repo: Repo, id: string) => (await repo.getPending(id))!.createdDocs;

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
    const d1 = debitLeg();
    const d2 = debitLeg2();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d1, d2, c]);
    await answer(repo, erp, d1);
    await answer(repo, erp, d2);
    const second = await answer(repo, erp, c);
    expect(second.link).toEqual({ status: 'several', count: 2 });
    expect(second.plan.steps[0].body.reference_no).toBe(`AL-${c.rawHash}`);
    expect(docs).toHaveLength(3);
  });

  it('an unmapped counter account is not searched at all', async () => {
    const repo = await createRepo(createTestDriver());
    const spy = jest.spyOn(repo, 'listPending');
    const own = planFor(creditLeg(), { mapping: BANK2, action: 'transfer', fromAccount: { bankAccount: 'ICICI Savings - ZP', glAccount: 'ICICI - ZP' } }, settings).plan;
    expect(await findCounterpartLeg(creditLeg(), null, own, repo, MAPPINGS)).toEqual({ status: 'none' });
    expect(spy).not.toHaveBeenCalled();
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

describe('only a real, unpaired transfer leg qualifies (R57)', () => {
  it("N1: a customer receipt on the counter account is not a transfer leg: the transfer books its own entry", async () => {
    // ₹30,000 from Acme into savings (real UTR), answered as a customer advance; then the current-account debit.
    const acme = smsTxn('idfc-006', [['XXXXXXX6507', 'XXXXXXX1111'], ['05-11-2026', '19-10-2026']], T0 + 60_000);
    const d = debitLeg();
    const { repo, erp, docs } = await world([acme, d]);
    await answerWith(repo, erp, acme, { mapping: BANK2, action: 'customer_advance', party: { doctype: 'Customer', name: 'Acme' } });
    const r = await answer(repo, erp, d);
    expect(r.link).toEqual({ status: 'none' });
    expect(r.plan.steps[0].body.reference_no).toBe('IDFB6292M4509651');
    expect(docs.map((x) => x.body.payment_type)).toEqual(['Receive', 'Internal Transfer']);
    expect(await docOf(repo, d.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]);
  });

  it('N1: three read accounts: a credit on savings "from current" does not link to a current -> payroll transfer', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, c]);
    await answerWith(repo, erp, d, { mapping: BANK, action: 'transfer', toAccount: BANK3 });
    expect((await answer(repo, erp, c)).link).toEqual({ status: 'none' });
    expect(docs).toHaveLength(2);
    expect(docs[1].body).toMatchObject({ paid_from: 'IDFC First - ZP', paid_to: 'IDFC Savings - ZP' });
  });

  it('N2: two equal transfers answered D1, C1, D2, C2: two entries, each leg on its own pair', async () => {
    const [d1, c1, d2, c2] = [debitLeg(), creditLeg(), debitLeg2(), creditLeg2()];
    const { repo, erp, docs } = await world([d1, c1, d2, c2]);
    await answer(repo, erp, d1);
    expect((await answer(repo, erp, c1)).link).toMatchObject({ status: 'linked', txnId: d1.id });
    expect((await answer(repo, erp, d2)).link).toEqual({ status: 'none' }); // C1 is already paired
    expect((await answer(repo, erp, c2)).link).toMatchObject({ status: 'linked', txnId: d2.id, reference: 'IDFB6292M4509999' });
    expect(docs.map((x) => x.body.reference_no)).toEqual(['IDFB6292M4509651', 'IDFB6292M4509999']);
    expect(await docOf(repo, c1.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }]);
    expect(await docOf(repo, d2.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]);
    expect(await docOf(repo, c2.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0, adopted: true }]);
  });

  it('N2: answered C1, D1, D2, C2: two entries; D2 does not re-link to the paired C1', async () => {
    const [d1, c1, d2, c2] = [debitLeg(), creditLeg(), debitLeg2(), creditLeg2()];
    const { repo, erp, docs } = await world([d1, c1, d2, c2]);
    await answer(repo, erp, c1);
    expect((await answer(repo, erp, d1)).link).toMatchObject({ status: 'linked', txnId: c1.id, reference: `AL-${c1.rawHash}` });
    expect((await answer(repo, erp, d2)).link).toEqual({ status: 'none' });
    // C2: D1 is an adopter, D2 is free.
    expect((await answer(repo, erp, c2)).link).toMatchObject({ status: 'linked', txnId: d2.id });
    expect(docs).toHaveLength(2);
    expect((await docOf(repo, d1.id))[0]).toMatchObject({ name: 'ACC-PAY-0001', adopted: true });
    expect((await docOf(repo, d2.id))[0]).toEqual({ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 });
    expect((await docOf(repo, c2.id))[0]).toMatchObject({ name: 'ACC-PAY-0002', adopted: true });
    for (const t of [d1, c1, d2, c2]) expect((await repo.getPending(t.id))!.state).toBe('created');
  });

  it('a first leg queued offline is linked by the second: one document, adopted by the second after the drain', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, c]);
    erp.findDraftsByUtr.mockRejectedValueOnce(new ErpNetworkError('offline'));
    expect((await answer(repo, erp, d)).o.kind).toBe('offline');
    const second = await answer(repo, erp, c); // online again: the second leg creates, the queued first adopts on drain
    expect(second.link).toEqual({ status: 'linked', reference: 'IDFB6292M4509651', txnId: d.id, docName: null, counterLabel: 'IDFC First' });
    expect(docs).toHaveLength(1);
    expect(docs[0].body.reference_no).toBe('IDFB6292M4509651');
    await drainOutbox({ repo, erp, now: () => T0 });
    expect(docs).toHaveLength(1);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
    const [dd, cd] = [await docOf(repo, d.id), await docOf(repo, c.id)];
    // whichever ran second adopted the one document
    expect([dd[0].name, cd[0].name]).toEqual(['ACC-PAY-0001', 'ACC-PAY-0001']);
    expect([!!dd[0].adopted, !!cd[0].adopted].filter(Boolean)).toHaveLength(1);
  });

  it('both legs queued offline: one outbox op each, one document after the drain, adopted on the second', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp, docs } = await world([d, c]);
    erp.findDraftsByUtr.mockRejectedValueOnce(new ErpNetworkError('offline')).mockRejectedValueOnce(new ErpNetworkError('offline'));
    expect((await answer(repo, erp, d)).o.kind).toBe('offline');
    const second = await answer(repo, erp, c);
    expect(second.o.kind).toBe('offline');
    expect(second.link).toMatchObject({ status: 'linked', txnId: d.id, docName: null });
    expect((await repo.listOutbox(d.id)).map((o) => o.status)).toEqual(['pending']);
    expect((await repo.listOutbox(c.id)).map((o) => o.status)).toEqual(['pending']);
    await drainOutbox({ repo, erp, now: () => T0 });
    expect(docs).toHaveLength(1);
    expect(await docOf(repo, d.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    expect(await docOf(repo, c.id)).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }]);
  });

  it('pure: a different paid_to, an adopter, a doc listed elsewhere and a reference used elsewhere are excluded', async () => {
    const d = debitLeg();
    const c = creditLeg();
    const { repo, erp } = await world([d, c]);
    await answer(repo, erp, d);
    const own = planFor(c, intoSavings, settings).plan;
    const leg = transferLegOf(own)!;
    const [txns, items] = [await repo.listPending(), await repo.listActiveOutbox()];
    expect(counterpartCandidates(c, BANK, leg, txns, items, MAPPINGS).map((x) => [x.txn.id, x.reference, x.docName])).toEqual([[d.id, 'IDFB6292M4509651', 'ACC-PAY-0001']]);
    expect(counterpartCandidates(c, BANK, { ...leg, paidTo: 'IDFC Payroll - ZP' }, txns, items, MAPPINGS)).toEqual([]);
    const asAdopter = txns.map((t) => (t.id === d.id ? { ...t, createdDocs: t.createdDocs.map((x) => ({ ...x, adopted: true })) } : t));
    expect(counterpartCandidates(c, BANK, leg, asAdopter, items, MAPPINGS)).toEqual([]);
    const other = { ...c, id: 't_x', rawHash: 'x', state: 'created' as const, createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }] };
    expect(counterpartCandidates(c, BANK, leg, [...txns, other], items, MAPPINGS)).toEqual([]);
    const usedPlan = { ...items[0], id: 'o-x', txnId: 't_y' };
    expect(counterpartCandidates(c, BANK, leg, txns, [...items, usedPlan], MAPPINGS)).toEqual([]);
    expect(transferLegOf({ steps: [], summary: [], needsInrAmount: false })).toBeNull();
  });
});
