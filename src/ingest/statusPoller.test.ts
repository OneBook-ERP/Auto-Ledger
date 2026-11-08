import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import type { PendingTxn } from '../core/types';
import { ErpAuthError, ErpNetworkError } from '../erp/client';
import { FakeDocsErp } from '../outbox/fakeErp.testutil';
import { undoTxn } from '../outbox/runner';
import { bringBack, pollStatuses } from './statusPoller';
import type { ErpOps } from '../outbox/runner';

const PE = (n: string) => `Payment Entry:${n}`;
const doc = (name: string, docstatus = 0, doctype = 'Payment Entry') => ({ doctype, name, docstatus });
const txn = (id: string, over: Partial<PendingTxn> = {}): PendingTxn => ({
  id, mergedCount: 1, state: 'created', createdDocs: [doc(`PE-${id}`)], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 1000, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: null, accountType: 'bank', accountLast4: '3455',
  counterparty: 'ACME', utr: `U${id}`, merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1762300000000, rawHash: `h${id}`, ...over,
});

async function setup(txns: PendingTxn[], docs: Record<string, number>) {
  const repo: Repo = await createRepo(createTestDriver());
  for (const t of txns) await repo.upsertPending(t);
  const erp = new FakeDocsErp(docs);
  return { repo, erp, deps: { repo, erp: erp as unknown as ErpOps, now: () => 1 } };
}

const deps2 = (repo: Repo, erp: FakeDocsErp) => ({ repo, erp: erp as unknown as ErpOps });

describe('pollStatuses', () => {
  it('flips a txn to submitted when all its docs are submitted, in one batched call', async () => {
    const { repo, erp, deps } = await setup(
      [txn('1', { createdDocs: [doc('PE-1'), doc('JV-1', 0, 'Journal Entry')] }), txn('2'), txn('3', { state: 'new', createdDocs: [] })],
      { [PE('PE-1')]: 1, 'Journal Entry:JV-1': 1, [PE('PE-2')]: 0 },
    );
    const r = await pollStatuses(deps);
    expect(r).toEqual({ checked: 2, submitted: 1, cancelled: 0, missing: 0 });
    expect(erp.count('getDocStatuses')).toBe(1);
    const t1 = (await repo.getPending('1'))!;
    expect(t1.state).toBe('submitted');
    expect(t1.createdDocs.map((d) => d.docstatus)).toEqual([1, 1]);
    const t2 = (await repo.getPending('2'))!;
    expect(t2.state).toBe('created');
    expect((await repo.getPending('3'))!.state).toBe('new');
  });

  it('partial: one of two docs submitted keeps the txn created and records it', async () => {
    const { repo, deps } = await setup([txn('1', { createdDocs: [doc('PE-1'), doc('PE-2')] })], { [PE('PE-1')]: 1, [PE('PE-2')]: 0 });
    const r = await pollStatuses(deps);
    expect(r.submitted).toBe(0);
    const t = (await repo.getPending('1'))!;
    expect(t.state).toBe('created');
    expect(t.createdDocs.map((d) => d.docstatus)).toEqual([1, 0]);
  });

  it('records cancelled (2) and missing (-1) without changing the state', async () => {
    const { repo, deps } = await setup(
      [txn('1', { createdDocs: [doc('PE-1'), doc('PE-2')] })],
      { [PE('PE-1')]: 2 },
    );
    const r = await pollStatuses(deps);
    expect(r).toEqual({ checked: 1, submitted: 0, cancelled: 1, missing: 1 });
    const t = (await repo.getPending('1'))!;
    expect(t.state).toBe('created');
    expect(t.createdDocs.map((d) => d.docstatus)).toEqual([2, -1]);
  });

  it('a missing doc that reappears is updated again', async () => {
    const { repo, erp, deps } = await setup([txn('1', { createdDocs: [doc('PE-1', -1)] })], {});
    erp.docs.set(PE('PE-1'), 1);
    await pollStatuses(deps);
    expect((await repo.getPending('1'))!).toMatchObject({ state: 'submitted', createdDocs: [{ docstatus: 1 }] });
  });

  it('a network or auth error changes nothing and does not throw', async () => {
    const t = txn('1');
    const { repo, erp, deps } = await setup([t], { [PE('PE-1')]: 1 });
    erp.failNext('getDocStatuses', new ErpNetworkError('offline'));
    await expect(pollStatuses(deps)).resolves.toEqual({ checked: 0, submitted: 0, cancelled: 0, missing: 0 });
    erp.failNext('getDocStatuses', new ErpAuthError('403', 403));
    await expect(pollStatuses(deps)).resolves.toEqual({ checked: 0, submitted: 0, cancelled: 0, missing: 0 });
    expect(await repo.getPending('1')).toEqual(t);
    expect(await repo.getSetting('needs_login_since')).toBeNull();
  });

  it('a 401 is reported and persisted as needs_login_since, changing nothing else', async () => {
    const t = txn('1');
    const { repo, erp, deps } = await setup([t], { [PE('PE-1')]: 1 });
    erp.failNext('getDocStatuses', new ErpAuthError('401', 401));
    await expect(pollStatuses(deps)).resolves.toEqual({ checked: 0, submitted: 0, cancelled: 0, missing: 0, needsLogin: true });
    expect(await repo.getSetting('needs_login_since')).toBe('1');
    expect(await repo.getPending('1')).toEqual(t);
  });

  it('a doc set that changed while the poll was in flight (Undo, then answered again) is not marked missing', async () => {
    const { repo, erp, deps } = await setup([txn('1')], { [PE('PE-1')]: 0 });
    let n = 0;
    let open!: () => void;
    const g = new Promise<void>((r) => (open = r));
    erp.gates.getDocStatuses = async () => { if (n++ === 0) await g; }; // hold only the poll's request
    const poll = pollStatuses(deps);
    await erp.called('getDocStatuses');
    
    expect(await undoTxn('1', deps2(repo, erp))).toEqual({ status: 'undone' });
    // answered again: the txn is created with a NEW document the poll never asked about
    const cur = (await repo.getPending('1'))!;
    await repo.upsertPending({ ...cur, state: 'created', createdDocs: [doc('PE-9')] });
    erp.docs.set(PE('PE-9'), 0);
    open();
    expect(await poll).toMatchObject({ checked: 0, missing: 0 });
    expect((await repo.getPending('1'))!.createdDocs).toEqual([doc('PE-9')]);
  });

  it('makes no call when nothing is waiting', async () => {
    const { erp, deps } = await setup([txn('1', { state: 'submitted' })], {});
    expect(await pollStatuses(deps)).toEqual({ checked: 0, submitted: 0, cancelled: 0, missing: 0 });
    expect(erp.calls).toHaveLength(0);
  });

  it('does not overwrite a field changed while the statuses were being fetched (re-reads inside the lock)', async () => {
    const { repo, erp, deps } = await setup([txn('1')], { [PE('PE-1')]: 1 });
    erp.afterStatuses = async () => {
      const t = await repo.getPending('1');
      await repo.upsertPending({ ...t!, counterparty: 'RENAMED', mergedCount: 2 });
    };
    await pollStatuses(deps);
    expect((await repo.getPending('1'))!).toMatchObject({ state: 'submitted', counterparty: 'RENAMED', mergedCount: 2 });
  });

  it('skips a txn that was undone while the statuses were being fetched', async () => {
    const { repo, erp, deps } = await setup([txn('1')], { [PE('PE-1')]: 1 });
    erp.afterStatuses = async () => {
      const t = await repo.getPending('1');
      await repo.upsertPending({ ...t!, state: 'new', createdDocs: [] });
    };
    await pollStatuses(deps);
    expect((await repo.getPending('1'))!).toMatchObject({ state: 'new', createdDocs: [] });
  });
});

describe('bringBack', () => {
  it('turns an ignored txn into new without any ERPNext call, and only if it is still ignored', async () => {
    const { repo } = await setup([txn('1', { state: 'ignored', createdDocs: [] }), txn('2', { state: 'created' })], {});
    expect(await bringBack('1', { repo })).toBe(true);
    expect((await repo.getPending('1'))!.state).toBe('new');
    expect(await bringBack('2', { repo })).toBe(false);
    expect((await repo.getPending('2'))!.state).toBe('created');
    expect(await bringBack('zzz', { repo })).toBe(false);
  });
});
