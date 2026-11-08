import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import type { ActionPlan, PendingTxn } from '../core/types';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import { NotDraftError } from '../erp/docs';
import { FakeDocsErp } from './fakeErp.testutil';
import { pollStatuses } from '../ingest/statusPoller';
import { outboxIdFor, undoTxn, type ErpOps } from './runner';

const PE = (n: string) => `Payment Entry:${n}`;
const doc = (name: string, docstatus = 0, doctype = 'Payment Entry') => ({ doctype, name, docstatus });
const SUBMITTED_MSG = 'Your accountant already submitted this entry. Cancel it in ERPNext if it is wrong.';

const txn = (over: Partial<PendingTxn> = {}): PendingTxn => ({
  id: 't1', mergedCount: 1, state: 'created', createdDocs: [doc('PE-1')], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 1234500, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: '10:30', accountType: 'bank', accountLast4: '3455',
  counterparty: 'ACME TRADERS', utr: 'UTR123', merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1762300000000, rawHash: 'h1', ...over,
});

const plan: ActionPlan = {
  steps: [{ kind: 'create_doc', doctype: 'Payment Entry', body: { reference_no: 'UTR123' } }],
  summary: [], needsInrAmount: false,
};

async function setup(t: PendingTxn = txn(), docs: Record<string, number> = { [PE('PE-1')]: 0 }, withOutbox = true) {
  const repo: Repo = await createRepo(createTestDriver());
  await repo.upsertPending(t);
  if (withOutbox) {
    await repo.enqueue({
      id: outboxIdFor(t.id, plan), txnId: t.id, plan, attempts: 1, status: 'done',
      progress: { stepIndex: 1, created: [{ doctype: 'Payment Entry', name: 'PE-1' }] },
    });
  }
  const erp = new FakeDocsErp(docs);
  return { repo, erp, deps: { repo, erp: erp as unknown as ErpOps } };
}

describe('undoTxn', () => {
  it('happy path: deletes the drafts, puts the txn back to new and supersedes its outbox item', async () => {
    const t = txn({ createdDocs: [doc('PE-1'), doc('JV-1', 0, 'Journal Entry')] });
    const { repo, erp, deps } = await setup(t, { [PE('PE-1')]: 0, 'Journal Entry:JV-1': 0 });
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    const saved = (await repo.getPending('t1'))!;
    expect(saved).toEqual({ ...t, state: 'new', createdDocs: [], error: null });
    expect(erp.docs.size).toBe(0);
    // newest first
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args[1])).toEqual(['JV-1', 'PE-1']);
    const ob = await repo.listOutbox('t1');
    expect(ob.map((o) => o.status)).toEqual(['superseded']);
    expect(await repo.nextOutbox()).toBeNull();
  });

  it('works without an outbox item', async () => {
    const { repo, deps } = await setup(txn(), { [PE('PE-1')]: 0 }, false);
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });

  it('refuses when a doc was submitted: nothing deleted, txn flips to submitted', async () => {
    const t = txn({ createdDocs: [doc('PE-1'), doc('PE-2')] });
    const { repo, erp, deps } = await setup(t, { [PE('PE-1')]: 0, [PE('PE-2')]: 1 });
    const r = await undoTxn('t1', deps);
    expect(r).toEqual({ status: 'refused', reason: 'submitted', message: SUBMITTED_MSG });
    expect(erp.count('deleteDraft')).toBe(0);
    const saved = (await repo.getPending('t1'))!;
    expect(saved.state).toBe('submitted');
    expect(saved.createdDocs.map((d) => d.docstatus)).toEqual([0, 1]);
    expect((await repo.listOutbox('t1'))[0].status).toBe('done');
  });

  it('a NotDraftError race (submitted between status read and delete) is refused as submitted', async () => {
    const { repo, erp, deps } = await setup();
    erp.afterStatuses = () => { erp.docs.set(PE('PE-1'), 1); };
    const r = await undoTxn('t1', deps);
    expect(r).toMatchObject({ status: 'refused', reason: 'submitted', message: SUBMITTED_MSG });
    expect((await repo.getPending('t1'))!.state).toBe('submitted');
  });

  it('a doc missing from ERPNext (or cancelled) counts as already gone', async () => {
    const t = txn({ createdDocs: [doc('PE-1'), doc('PE-2'), doc('PE-3')] });
    const { repo, erp, deps } = await setup(t, { [PE('PE-2')]: 2, [PE('PE-3')]: 0 });
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args[1])).toEqual(['PE-3']);
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'new', createdDocs: [] });
  });

  it('partial failure keeps the remaining docs, stays created, and a retry finishes the job', async () => {
    const t = txn({ createdDocs: [doc('PE-1'), doc('PE-2'), doc('PE-3')] });
    const { repo, erp, deps } = await setup(t, { [PE('PE-1')]: 0, [PE('PE-2')]: 0, [PE('PE-3')]: 0 });
    // newest first: PE-3 is deleted, then PE-2 fails
    erp.failDeleteOf.set('PE-2', new ErpNetworkError('Could not reach the ERPNext site.'));
    const r = await undoTxn('t1', deps);
    expect(r).toMatchObject({ status: 'failed', retryable: true });
    expect(r.status === 'failed' && r.error).toBeInstanceOf(ErpNetworkError);
    const mid = (await repo.getPending('t1'))!;
    expect(mid.state).toBe('created');
    expect(mid.createdDocs.map((d) => d.name)).toEqual(['PE-1', 'PE-2']);
    expect([...erp.docs.keys()].sort()).toEqual([PE('PE-1'), PE('PE-2')]);
    expect((await repo.listOutbox('t1'))[0].status).toBe('done'); // not superseded while a draft exists
    erp.failDeleteOf.clear(); // network is back
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect(erp.docs.size).toBe(0);
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'new', createdDocs: [] });
  });

  it('a validation error from the server is failed and not retryable; never marks new', async () => {
    const { repo, erp, deps } = await setup();
    erp.failNext('deleteDraft', new ErpValidationError('Linked to other documents', 417));
    const r = await undoTxn('t1', deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect((await repo.getPending('t1'))!.state).toBe('created');
  });

  it('a network error while reading statuses changes nothing', async () => {
    const t = txn();
    const { repo, erp, deps } = await setup(t);
    erp.failNext('getDocStatuses', new ErpNetworkError('offline'));
    expect(await undoTxn('t1', deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(await repo.getPending('t1')).toEqual(t);
    expect(erp.count('deleteDraft')).toBe(0);
  });

  it('auth errors give needs_login and change nothing', async () => {
    const t = txn();
    const { repo, erp, deps } = await setup(t);
    erp.failNext('getDocStatuses', new ErpAuthError('401', 401));
    expect(await undoTxn('t1', deps)).toEqual({ status: 'needs_login' });
    erp.failNext('deleteDraft', new ErpAuthError('401', 401));
    expect(await undoTxn('t1', deps)).toEqual({ status: 'needs_login' });
    expect(await repo.getPending('t1')).toEqual(t);
  });

  it('running it twice is safe: the second call refuses with not_created and changes nothing', async () => {
    const { repo, erp, deps } = await setup();
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    const after = await repo.getPending('t1');
    const calls = erp.calls.length;
    const r = await undoTxn('t1', deps);
    expect(r).toMatchObject({ status: 'refused', reason: 'not_created' });
    expect(await repo.getPending('t1')).toEqual(after);
    expect(erp.calls.length).toBe(calls);
  });

  it('refuses a txn that is not created, and an unknown txn', async () => {
    for (const state of ['new', 'submitted', 'ignored', 'failed'] as const) {
      const t = txn({ state, createdDocs: state === 'submitted' ? [doc('PE-1', 1)] : [] });
      const { repo, erp, deps } = await setup(t);
      expect(await undoTxn('t1', deps)).toMatchObject({ status: 'refused', reason: 'not_created' });
      expect(erp.calls).toHaveLength(0);
      expect(await repo.getPending('t1')).toEqual(t);
    }
    const { deps } = await setup();
    expect(await undoTxn('nope', deps)).toMatchObject({ status: 'refused', reason: 'not_found' });
  });

  it('docsAlreadyGone: cancelled/missing docs are not deleted and no network is needed when all are gone', async () => {
    const t = txn({ createdDocs: [doc('PE-1', 2), doc('PE-2', -1)] });
    const { repo, erp, deps } = await setup(t, {});
    expect(await undoTxn('t1', deps, { docsAlreadyGone: true })).toEqual({ status: 'undone' });
    expect(erp.calls).toHaveLength(0);
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'new', createdDocs: [] });
    expect((await repo.listOutbox('t1'))[0].status).toBe('superseded');
  });

  it('docsAlreadyGone: a remaining draft is still deleted, a gone doc is not', async () => {
    const t = txn({ createdDocs: [doc('PE-1', 2), doc('PE-2', 0)] });
    const { repo, erp, deps } = await setup(t, { [PE('PE-1')]: 2, [PE('PE-2')]: 0 });
    expect(await undoTxn('t1', deps, { docsAlreadyGone: true })).toEqual({ status: 'undone' });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args[1])).toEqual(['PE-2']);
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });

  it('docsAlreadyGone never overrides a doc that is submitted in ERPNext now', async () => {
    const t = txn({ createdDocs: [doc('PE-1', 2), doc('PE-2', 0)] });
    const { repo, deps } = await setup(t, { [PE('PE-1')]: 2, [PE('PE-2')]: 1 });
    expect(await undoTxn('t1', deps, { docsAlreadyGone: true })).toMatchObject({ status: 'refused', reason: 'submitted' });
    expect((await repo.getPending('t1'))!.state).toBe('submitted');
  });

  it('a stale outbox progress is reset so the user can answer again in the Inbox', async () => {
    const { repo, deps } = await setup();
    await undoTxn('t1', deps);
    expect((await repo.listOutbox('t1'))[0].progress).toEqual({ stepIndex: 0, created: [] });
  });
});

describe('undoTxn under the per-txn lock', () => {
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };

  it('a concurrent poll waits for Undo and then sees a txn that is no longer created', async () => {
    const { repo, erp, deps } = await setup();
    const g = gate();
    erp.gates.deleteDraft = () => g.p;
    const u = undoTxn('t1', deps);
    await new Promise((r) => setTimeout(r, 5));
    const poll = pollStatuses({ repo, erp: erp as unknown as ErpOps, now: () => 0 });
    await new Promise((r) => setTimeout(r, 5));
    g.open();
    expect(await u).toEqual({ status: 'undone' });
    await poll;
    const saved = (await repo.getPending('t1'))!;
    expect(saved).toMatchObject({ state: 'new', createdDocs: [] });
  });

  it('two Undos in parallel delete once', async () => {
    const { erp, deps } = await setup();
    const [a, b] = await Promise.all([undoTxn('t1', deps), undoTxn('t1', deps)]);
    expect([a.status, b.status].sort()).toEqual(['refused', 'undone']);
    expect(erp.count('deleteDraft')).toBe(1);
  });
});
