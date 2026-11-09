import { PlanError, planAction } from '../core/plan';
import type { ActionChoice, PendingTxn } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpNetworkError, ErpValidationError } from '../erp/client';
import { runPlan } from '../outbox/runner';
import { BULK_ONLY_ONE_BY_ONE, applyToGroup, type BulkDeps } from './bulk';
import { fakeInboxErp } from './fakeErp';
import { OFFLINE_MESSAGE } from './outcome';
import { CARD, txnFrom } from './testData';

const ctx = { company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-11-08', account: CARD };
const ads: ActionChoice = { type: 'expense', expenseAccount: 'Advertising - ZP' };

async function setup(n = 5, over: (i: number) => Partial<PendingTxn> = () => ({})) {
  const repo: Repo = await createRepo(createTestDriver());
  const base = txnFrom('idfc-035'); // card spend at FACEBOOK SI
  const items: PendingTxn[] = [];
  for (let i = 1; i <= n; i++) {
    const t = { ...base, id: `f${i}`, rawHash: `h${i}`, amountMinor: 10000 * i, receivedAt: base.receivedAt + i, ...over(i) };
    await repo.upsertPending(t);
    items.push(t);
  }
  const erp = fakeInboxErp();
  const run = jest.fn(runPlan);
  const plan = jest.fn((t: PendingTxn, c: ActionChoice) => planAction(t, c, ctx));
  const deps: BulkDeps = { repo, erp, runPlan: run, plan };
  return { repo, erp, run, plan, deps, items };
}

const states = async (repo: Repo, items: PendingTxn[]) =>
  Promise.all(items.map(async (t) => (await repo.getPending(t.id))?.state));

describe('applyToGroup', () => {
  it('5 items all succeed, one document each, and the rule learns the largest amount', async () => {
    const { repo, erp, deps, items } = await setup();
    const r = await applyToGroup(deps, items, ads);
    expect(r).toEqual({ done: ['f1', 'f2', 'f3', 'f4', 'f5'], failed: [], queued: [], skipped: [] });
    expect(erp.createDraft).toHaveBeenCalledTimes(5);
    expect(await states(repo, items)).toEqual(['created', 'created', 'created', 'created', 'created']);
    expect(await repo.listRules()).toEqual([
      expect.objectContaining({ matchKey: 'm:out:facebooksi', action: 'expense', hits: 5, maxAmountMinor: 50000, currency: 'INR', auto: false }),
    ]);
  });

  it('runs one item at a time by default', async () => {
    const { deps, items, run } = await setup(4);
    let active = 0; let peak = 0;
    run.mockImplementation(async (...a: Parameters<typeof runPlan>) => {
      active++; peak = Math.max(peak, active);
      try { await new Promise((res) => setTimeout(res, 1)); return await runPlan(...a); } finally { active--; }
    });
    expect((await applyToGroup(deps, items, ads)).done).toHaveLength(4);
    expect(peak).toBe(1);
  });

  it('item 3 fails: items 4 and 5 still run, the failure carries a plain message, nothing is rolled back', async () => {
    const { repo, erp, deps, items } = await setup();
    let call = 0;
    erp.createDraft.mockImplementation(async () => {
      call++;
      if (call === 3) throw new ErpValidationError('Value missing for Journal Entry: Cost Center', 417, ['Cost Center']);
      return { name: `JE-${call}` };
    });
    const r = await applyToGroup(deps, items, ads);
    expect(r.done).toEqual(['f1', 'f2', 'f4', 'f5']);
    expect(r.failed).toEqual([{ id: 'f3', message: expect.stringContaining('ERPNext needs these fields: Cost Center') }]);
    expect(await states(repo, items)).toEqual(['created', 'created', 'new', 'created', 'created']);

    // Retrying the whole group after the fix: only f3 is sent; nothing is created twice.
    erp.createDraft.mockClear();
    erp.createDraft.mockImplementation(async () => ({ name: 'JE-retry' }));
    const again = await applyToGroup(deps, items, ads);
    expect(again).toEqual({ done: ['f3'], failed: [], queued: [], skipped: ['f1', 'f2', 'f4', 'f5'] });
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
  });

  it('a throwing runner or planner fails only that item', async () => {
    const { deps, items, run, plan } = await setup(3);
    run.mockImplementationOnce(async () => { throw new Error('disk'); });
    plan.mockImplementation((t, c) => {
      if (t.id === 'f2') throw new PlanError('missing_amount');
      return planAction(t, c, ctx);
    });
    const r = await applyToGroup(deps, items, ads);
    expect(r.done).toEqual(['f3']);
    expect(r.failed).toEqual([
      { id: 'f1', message: expect.stringMatching(/Something went wrong/) },
      { id: 'f2', message: 'Enter the amount in rupees first. Go back to the amount step.' },
    ]);
  });

  it('an item already answered, or whose answer is already queued, is skipped (the stored row decides, not the input)', async () => {
    const { repo, erp, deps, items } = await setup(3);
    // f1 was answered elsewhere after the list was read; the input still says 'new'.
    await repo.upsertPending({ ...items[0], state: 'created', createdDocs: [{ doctype: 'Journal Entry', name: 'JE-OLD', docstatus: 0 }] });
    // f2 has an answer waiting to be sent.
    await repo.enqueue({ id: 'f2#x', txnId: 'f2', plan: planAction(items[1], ads, ctx), progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    const r = await applyToGroup(deps, items, ads);
    expect(r).toEqual({ done: ['f3'], failed: [], queued: [], skipped: ['f1', 'f2'] });
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
  });

  it('an item no longer in the Inbox is skipped; a repeated id runs once', async () => {
    const { erp, deps, items } = await setup(2);
    const gone = { ...items[0], id: 'nope', rawHash: 'zz' };
    const r = await applyToGroup(deps, [items[0], gone, items[0], items[1]], ads);
    expect(r).toEqual({ done: ['f1', 'f2'], failed: [], queued: [], skipped: ['nope'] });
    expect(erp.createDraft).toHaveBeenCalledTimes(2);
  });

  it('offline queues each item exactly as a single answer does, and a retry does not queue or create again', async () => {
    const { repo, erp, deps, items, run } = await setup(3);
    erp.createDraft.mockRejectedValue(new ErpNetworkError('offline'));
    const r = await applyToGroup(deps, items, ads);
    expect(r).toEqual({ done: [], failed: [], queued: ['f1', 'f2', 'f3'], skipped: [] });
    expect(OFFLINE_MESSAGE).toMatch(/saved/);
    expect(await states(repo, items)).toEqual(['new', 'new', 'new']);
    for (const t of items) expect((await repo.listOutbox(t.id)).map((o) => o.status)).toEqual(['pending']);
    expect(await repo.listRules()).toEqual([]);
    run.mockClear();
    const again = await applyToGroup(deps, items, ads);
    expect(again.skipped).toEqual(['f1', 'f2', 'f3']);
    expect(run).not.toHaveBeenCalled();
  });

  it('signed out: the answer is kept for sending and the item says to sign in', async () => {
    const { repo, erp, deps, items } = await setup(2);
    const { ErpAuthError } = jest.requireActual('../erp/client');
    erp.createDraft.mockRejectedValue(new ErpAuthError('expired', 401));
    erp.checkSession.mockResolvedValue(false);
    const r = await applyToGroup(deps, items, ads);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.id)).toEqual(['f1', 'f2']);
    expect(r.failed[0].message).toMatch(/Sign in again/);
    for (const t of items) expect((await repo.listOutbox(t.id)).map((o) => o.status)).toEqual(['pending']);
  });

  it('answers that must be given one by one are refused for every item, and nothing runs', async () => {
    const { deps, items, run } = await setup(2);
    const party = { doctype: 'Customer' as const, name: 'C' };
    for (const choice of [
      { type: 'customer_advance', party },
      { type: 'salary', party: { doctype: 'Employee', name: 'E' } },
      { type: 'against_invoice', party, invoices: [] },
      { type: 'bill_paid_by_card', party, invoice: { name: 'PI', allocatedMinor: 1 } },
      { type: 'transfer', toAccount: CARD },
    ] as ActionChoice[]) {
      const r = await applyToGroup(deps, items, choice);
      expect(r.failed).toEqual([{ id: 'f1', message: BULK_ONLY_ONE_BY_ONE }, { id: 'f2', message: BULK_ONLY_ONE_BY_ONE }]);
      expect(r.done).toEqual([]);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('concurrency above 1 still answers every item once and reports in input order', async () => {
    const { erp, deps, items } = await setup(5);
    const r = await applyToGroup(deps, items, ads, { concurrency: 3 });
    expect(r.done).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(erp.createDraft).toHaveBeenCalledTimes(5);
  });

  it('remember false learns nothing', async () => {
    const { repo, deps, items } = await setup(2);
    await applyToGroup(deps, items, ads, { remember: false });
    expect(await repo.listRules()).toEqual([]);
  });
});
