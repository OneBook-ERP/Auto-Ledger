import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import { runPlan } from '../outbox/runner';
import { planFor } from './flow';
import { fakeInboxErp } from './fakeErp';
import { isSubmitting, submitAnswer } from './submit';
import { UNKNOWN_FAILURE } from './outcome';
import { BANK, txnFrom } from './testData';

const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-11-08' };
const acme = { doctype: 'Customer' as const, name: 'Acme Test Traders' };

async function setup() {
  const repo: Repo = await createRepo(createTestDriver());
  const txn = txnFrom('idfc-006');
  await repo.upsertPending(txn);
  const erp = fakeInboxErp();
  const run = jest.fn(runPlan);
  const { plan, choice } = planFor(txn, { mapping: BANK, action: 'customer_advance', party: acme }, settings);
  return { repo, txn, erp, run, plan, choice };
}

describe('submitAnswer', () => {
  it('created: always userAction, learns the rule when asked', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    const o = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true });
    expect(o).toEqual({ kind: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-1' }] });
    expect(run).toHaveBeenCalledWith(txn.id, plan, { repo, erp }, { userAction: true });
    expect((await repo.getPending(txn.id))?.state).toBe('created');
    expect(await repo.listRules()).toEqual([{ matchKey: 'cp:in:company11', action: 'customer_advance', party: acme, hits: 1, lastUsed: txn.receivedAt }]);
  });
  it('remember off: no rule', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: false });
    expect(await repo.listRules()).toEqual([]);
  });
  it('an existing rule is updated, not duplicated', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    await repo.saveRule({ matchKey: 'cp:in:company11', action: 'customer_advance', party: acme, hits: 4, lastUsed: 1 });
    await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true });
    expect(await repo.listRules()).toEqual([{ matchKey: 'cp:in:company11', action: 'customer_advance', party: acme, hits: 5, lastUsed: txn.receivedAt }]);
  });
  it('needs_login with an invalid session: login; the txn stays new and its item stays queued', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    erp.createDraft.mockRejectedValue(new ErpAuthError('expired', 401));
    erp.checkSession.mockResolvedValue(false);
    expect(await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true })).toEqual({ kind: 'login' });
    expect((await repo.getPending(txn.id))?.state).toBe('new');
    expect((await repo.listOutbox(txn.id)).map((o) => o.status)).toEqual(['pending']);
    expect(await repo.listRules()).toEqual([]);
  });
  it('needs_login with a working session is a permission refusal, shown as an error', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    erp.createDraft.mockRejectedValue(new ErpAuthError('forbidden', 403));
    erp.checkSession.mockResolvedValue(true);
    const o = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true });
    expect(o).toMatchObject({ kind: 'error', message: expect.stringContaining('not allowed to create this document') });
  });
  it('retryable failure: offline; txn new, item pending, no rule learned', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    erp.createDraft.mockRejectedValue(new ErpNetworkError('offline'));
    const o = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true });
    expect(o.kind).toBe('offline');
    expect((await repo.getPending(txn.id))?.state).toBe('new');
    expect((await repo.listOutbox(txn.id)).map((x) => x.status)).toEqual(['pending']);
    expect(await repo.listRules()).toEqual([]);
  });
  it('validation failure: readable runner message, missing fields, no rule', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    erp.createDraft.mockRejectedValue(new ErpValidationError('Value missing for Payment Entry: Gender', 417, ['Gender']));
    const o = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true });
    expect(o).toMatchObject({ kind: 'error', missingFields: ['Gender'], doctype: 'Payment Entry' });
    expect(o.kind === 'error' && o.message).toContain('ERPNext needs these fields: Gender');
    expect(await repo.listRules()).toEqual([]);
  });
  it('a second submit for the same txn while one runs is refused (one runPlan call)', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    let release!: () => void;
    erp.findDraftByUtr.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    const first = submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(isSubmitting(txn.id)).toBe(true);
    expect(await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: false })).toEqual({ kind: 'busy' });
    release();
    expect((await first).kind).toBe('created');
    expect(run).toHaveBeenCalledTimes(1);
    expect(isSubmitting(txn.id)).toBe(false);
  });
  it('ignore: the empty plan marks the txn ignored and can be remembered', async () => {
    const { repo, txn, erp, run } = await setup();
    const { plan, choice } = planFor(txn, { mapping: BANK, action: 'ignore' }, settings);
    expect(await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: true })).toEqual({ kind: 'created', docs: [] });
    expect((await repo.getPending(txn.id))?.state).toBe('ignored');
    expect((await repo.listRules())[0]).toMatchObject({ matchKey: 'cp:in:company11', action: 'ignore' });
  });
  it('a repeated identical failure still gets the readable runner message', async () => {
    const { repo, txn, erp, run, plan, choice } = await setup();
    erp.createDraft.mockRejectedValue(new ErpValidationError('Value missing', 417, ['Gender']));
    const first = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: false });
    const second = await submitAnswer({ repo, erp, runPlan: run }, { txn, plan, choice, remember: false });
    expect(first.kind === 'error' && first.message).toContain('ERPNext needs these fields: Gender');
    expect(second).toEqual(first);
  });

  describe('runPlan throws (not an ERP result)', () => {
    it('txn still new: a plain "may not have been saved" error', async () => {
      const { repo, txn, erp, plan, choice } = await setup();
      const run = jest.fn(async () => { throw new Error('SQLITE_BUSY'); });
      const o = await submitAnswer({ repo, erp, runPlan: run as never }, { txn, plan, choice, remember: true });
      expect(o).toEqual({ kind: 'error', message: UNKNOWN_FAILURE, missingFields: [], doctype: null, closedPeriod: false });
      expect(isSubmitting(txn.id)).toBe(false);
      expect(await repo.listRules()).toEqual([]);
    });
    it('txn already created (the work finished): reported as created with its documents', async () => {
      const { repo, txn, erp, plan, choice } = await setup();
      const run = jest.fn(async () => {
        await repo.upsertPending({ ...txn, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-7', docstatus: 0 }] });
        throw new Error('lost');
      });
      expect(await submitAnswer({ repo, erp, runPlan: run as never }, { txn, plan, choice, remember: false })).toEqual({ kind: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-7' }] });
    });
    it('txn gone (Undo / site switch): gone; the real runner throws "not found"', async () => {
      const { txn, erp, run, plan, choice } = await setup();
      const repo2 = await createRepo(createTestDriver()); // the row is not there
      expect(await submitAnswer({ repo: repo2, erp, runPlan: run }, { txn, plan, choice, remember: false })).toEqual({ kind: 'gone' });
      expect(run).toHaveBeenCalledTimes(1);
      await expect(run.mock.results[0].value).rejects.toThrow(/not found/);
    });
  });
});

