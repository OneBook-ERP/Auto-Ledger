import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { planAction, type PlanContext } from '../core/plan';
import type { ActionPlan, PendingTxn } from '../core/types';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import * as runner from '../outbox/runner';
import { outboxIdFor, parkForPermission, runPlan } from '../outbox/runner';
import { PERMISSION_DENIED_MESSAGE, drainOutbox, type DrainErp } from './drain';

const NOW = 1794200000000;

const txn = (i: number, over: Partial<PendingTxn> = {}): PendingTxn => ({
  id: `t${i}`, mergedCount: 1, state: 'new', createdDocs: [], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 100000 + i, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: '10:30', accountType: 'bank', accountLast4: '6507',
  counterparty: null, utr: `UTR${i}`, merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB-S', receivedAt: NOW - 1000 * i, rawHash: `h${i}`, ...over,
});

const ctx: PlanContext = {
  company: 'Atom Ltd',
  account: { bankAccount: 'IDFC CA', glAccount: 'IDFC CA - AL', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Bank Transfer' },
  drawingsAccount: 'Drawings - AL', today: '2026-11-08',
};
const income = (t: PendingTxn, incomeAccount = 'Interest - AL'): ActionPlan => planAction(t, { type: 'other_income', incomeAccount }, ctx);

type Doc = { doctype: string; name: string; docstatus: number; ref: string };

/** Fake ERP: `failFor[ref]` makes createDraft for that reference throw (every time, or `times` times; only for bodies `when` accepts). */
class FakeErp implements DrainErp {
  docs: Doc[] = [];
  failFor: Record<string, { error: Error; times?: number; when?: (body: Record<string, unknown>) => boolean }> = {};
  session = true;
  checkSession = jest.fn(async () => this.session);
  private seq = 0;

  async findDraftByUtr(reference: string) {
    const d = this.docs.find((x) => x.ref === reference);
    return d ? { doctype: d.doctype, name: d.name, docstatus: d.docstatus } : null;
  }
  async createDraft(doctype: string, body: Record<string, unknown>) {
    const ref = String(body.cheque_no ?? body.reference_no);
    const f = this.failFor[ref];
    if (f && (f.times === undefined || f.times > 0) && (!f.when || f.when(body))) {
      if (f.times !== undefined) f.times--;
      throw f.error;
    }
    const name = `DOC-${++this.seq}`;
    this.docs.push({ doctype, name, docstatus: 0, ref });
    return { name };
  }
  async deleteDraft(doctype: string, name: string) { this.docs = this.docs.filter((d) => !(d.doctype === doctype && d.name === name)); }
  async searchParties() { return []; }
  async getDocStatuses(refs: { doctype: string; name: string }[]) {
    const out: Record<string, number> = {};
    for (const r of refs) {
      const d = this.docs.find((x) => x.doctype === r.doctype && x.name === r.name);
      if (d) out[`${d.doctype}:${d.name}`] = d.docstatus;
    }
    return out;
  }
  async createParty(): Promise<never> { throw new Error('unused'); }
}

const forbidden = () => new ErpAuthError('No permission for Journal Entry', 403, 'Journal Entry');

async function setup(n: number) {
  const repo = await createRepo(createTestDriver());
  const erp = new FakeErp();
  const items: { txnId: string; id: string }[] = [];
  for (let i = 1; i <= n; i++) {
    const t = txn(i);
    await repo.upsertPending(t);
    const plan = income(t);
    const id = outboxIdFor(t.id, plan);
    await repo.enqueue({ id, txnId: t.id, plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    items.push({ txnId: t.id, id });
  }
  let clock = NOW;
  const deps = { repo, erp, now: () => clock };
  return { repo, erp, items, deps, tick: (ms: number) => { clock += ms; } };
}

const status = async (repo: Repo, id: string) => (await repo.getOutbox(id))!.status;

describe('drainOutbox', () => {
  it('runs every pending item; created -> next', async () => {
    const { repo, erp, items, deps } = await setup(2);
    expect(await drainOutbox(deps)).toEqual({ ran: 2, stoppedBecause: 'empty' });
    for (const it of items) {
      expect(await status(repo, it.id)).toBe('done');
      expect((await repo.getPending(it.txnId))!.state).toBe('created');
    }
    expect(erp.docs.length).toBe(2);
  });

  it('empty outbox', async () => {
    const { deps } = await setup(0);
    expect(await drainOutbox(deps)).toEqual({ ran: 0, stoppedBecause: 'empty' });
  });

  it('a non-retryable failure moves on to the next item', async () => {
    const { repo, erp, items, deps } = await setup(2);
    erp.failFor.UTR1 = { error: new ErpValidationError('Value missing for Journal Entry: Cost Center', 417) };
    expect(await drainOutbox(deps)).toEqual({ ran: 2, stoppedBecause: 'empty' });
    expect(await status(repo, items[0].id)).toBe('failed');
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'new' });
    expect((await repo.getPending('t1'))!.error).toMatch(/Cost Center/);
    expect(await status(repo, items[1].id)).toBe('done');
  });

  it('a retryable failure stops with retry_later and leaves the rest queued', async () => {
    const { repo, erp, items, deps } = await setup(2);
    erp.failFor.UTR1 = { error: new ErpNetworkError('timeout') };
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'retry_later' });
    expect(await status(repo, items[0].id)).toBe('pending');
    expect(await status(repo, items[1].id)).toBe('pending');
    expect(erp.docs).toEqual([]);
  });

  it('needs_login stops, persists needs_login_since (first time) and keeps the item queued', async () => {
    const { repo, erp, items, deps, tick } = await setup(2);
    erp.failFor.UTR1 = { error: new ErpAuthError('bad key', 401) };
    erp.session = false;
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    expect(await status(repo, items[0].id)).toBe('pending');
    expect(await status(repo, items[1].id)).toBe('pending');
    tick(60_000);
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    expect(await repo.getSetting(`needs_login_count:${items[0].id}`)).toBe('0'); // invalid session: not counted
  });

  it('a later created result clears needs_login_since', async () => {
    const { repo, erp, deps } = await setup(1);
    erp.failFor.UTR1 = { error: new ErpAuthError('bad key', 401), times: 1 };
    erp.session = false;
    await drainOutbox(deps);
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'empty' });
    expect(await repo.getSetting('needs_login_since')).toBe('');
  });

  it('a permanent 403 on one item is parked after 3 tries when the session is still valid', async () => {
    const { repo, erp, items, deps } = await setup(2);
    erp.failFor.UTR1 = { error: forbidden() };
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(erp.checkSession).toHaveBeenCalledTimes(2); // asked on every needs_login result
    expect(await drainOutbox(deps)).toEqual({ ran: 2, stoppedBecause: 'empty' });
    expect(erp.checkSession).toHaveBeenCalledTimes(3);
    expect(await status(repo, items[0].id)).toBe('failed');
    expect(await repo.getPending('t1')).toMatchObject({ state: 'new', error: PERMISSION_DENIED_MESSAGE });
    expect(await status(repo, items[1].id)).toBe('done');
    expect(await repo.getSetting(`needs_login_count:${items[0].id}`)).toBe('0');
    expect(PERMISSION_DENIED_MESSAGE).toBe(
      'Your ERPNext user is not allowed to create this document; ask your administrator for access, then try again');
  });

  it('is not parked while the session itself is invalid', async () => {
    const { repo, erp, items, deps } = await setup(2);
    erp.failFor.UTR1 = { error: forbidden() };
    erp.session = false;
    for (let i = 0; i < 4; i++) expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(erp.checkSession).toHaveBeenCalledTimes(4);
    expect(await status(repo, items[0].id)).toBe('pending');
    expect(await repo.getSetting(`needs_login_count:${items[0].id}`)).toBe('0');
    expect((await repo.getPending('t1'))!.error).toBeNull();
  });

  it('a session check that throws counts as not valid', async () => {
    const { repo, erp, items, deps } = await setup(1);
    erp.failFor.UTR1 = { error: forbidden() };
    erp.checkSession.mockImplementation(async () => { throw new ErpNetworkError('offline'); });
    for (let i = 0; i < 3; i++) expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await status(repo, items[0].id)).toBe('pending');
  });

  it('any other result resets the needs_login counter', async () => {
    const { repo, erp, items, deps } = await setup(1);
    const key = `needs_login_count:${items[0].id}`;
    erp.failFor.UTR1 = { error: forbidden(), times: 2 };
    await drainOutbox(deps);
    await drainOutbox(deps);
    expect(await repo.getSetting(key)).toBe('2');
    erp.failFor.UTR1 = { error: new ErpNetworkError('timeout'), times: 1 };
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'retry_later' });
    expect(await repo.getSetting(key)).toBe('0');
    erp.failFor.UTR1 = { error: forbidden(), times: 2 };
    await drainOutbox(deps);
    await drainOutbox(deps);
    expect(await repo.getSetting(key)).toBe('2');
    expect(await status(repo, items[0].id)).toBe('pending');
  });

  it('long logged out, then re-login, then the first 403 does not park immediately', async () => {
    const { repo, erp, items, deps, tick } = await setup(1);
    const key = `needs_login_count:${items[0].id}`;
    erp.failFor.UTR1 = { error: new ErpAuthError('bad key', 401) };
    erp.session = false;
    for (let i = 0; i < 5; i++) {
      expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
      tick(3600_000);
    }
    expect(await repo.getSetting(key)).toBe('0');
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    // The user logs in again; the item now hits a permission 403.
    erp.session = true;
    erp.failFor.UTR1 = { error: forbidden() };
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await status(repo, items[0].id)).toBe('pending');
    expect(await repo.getSetting(key)).toBe('1');
    expect(await repo.getSetting('needs_login_since')).toBe(''); // the session works
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'needs_login' });
    expect(await status(repo, items[0].id)).toBe('pending');
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'empty' });
    expect(await status(repo, items[0].id)).toBe('failed');
  });

  it('parking a single item clears needs_login_since', async () => {
    const { repo, erp, items, deps } = await setup(1);
    erp.failFor.UTR1 = { error: forbidden() };
    erp.session = false;
    await drainOutbox(deps);
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    erp.session = true;
    await drainOutbox(deps);
    await drainOutbox(deps);
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'empty' });
    expect(await status(repo, items[0].id)).toBe('failed');
    expect(await repo.getPending('t1')).toMatchObject({ state: 'new', error: PERMISSION_DENIED_MESSAGE });
    expect(await repo.getSetting('needs_login_since')).toBe('');
  });

  it('a non-needs_login result clears needs_login_since (retryable failure too)', async () => {
    const { repo, erp, deps } = await setup(1);
    erp.session = false;
    erp.failFor.UTR1 = { error: new ErpAuthError('bad key', 401), times: 1 };
    await drainOutbox(deps);
    expect(await repo.getSetting('needs_login_since')).toBe(String(NOW));
    erp.failFor.UTR1 = { error: new ErpNetworkError('timeout'), times: 1 };
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'retry_later' });
    expect(await repo.getSetting('needs_login_since')).toBe('');
  });

  it('a user decision made during the session check is never overwritten by parking', async () => {
    const { repo, erp, items, deps } = await setup(2);
    // Plan A (Interest) is refused with 403; the user's plan B (another income account) is allowed.
    erp.failFor.UTR1 = { error: forbidden(), when: (b) => JSON.stringify(b).includes('Interest - AL') };
    await drainOutbox(deps);
    await drainOutbox(deps);
    let reached!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    let release!: (v: boolean) => void;
    erp.checkSession.mockImplementationOnce(() => {
      reached();
      return new Promise<boolean>((r) => { release = r; });
    });
    const drained = drainOutbox(deps);
    await atGate;
    const t1 = (await repo.getPending('t1'))!;
    const planB = income(t1, 'Misc Income - AL');
    const b = await runPlan('t1', planB, { repo, erp }, { userAction: true });
    expect(b.status).toBe('created');
    release(true);
    expect(await drained).toEqual({ ran: 2, stoppedBecause: 'empty' });
    expect(await status(repo, items[0].id)).toBe('superseded');
    expect(await status(repo, outboxIdFor('t1', planB))).toBe('done');
    const after = (await repo.getPending('t1'))!;
    expect(after.state).toBe('created');
    expect(after.error).toBeNull();
    expect(after.createdDocs).toEqual([{ doctype: 'Journal Entry', name: erp.docs.find((d) => d.ref === 'UTR1')!.name, docstatus: 0 }]);
    expect(await status(repo, items[1].id)).toBe('done');
  });

  describe('parkForPermission', () => {
    it('parks a pending item of a new txn', async () => {
      const { repo, items } = await setup(1);
      expect(await parkForPermission('t1', items[0].id, { repo })).toBe('parked');
      expect(await status(repo, items[0].id)).toBe('failed');
      expect(await repo.getPending('t1')).toMatchObject({ state: 'new', error: PERMISSION_DENIED_MESSAGE, createdDocs: [] });
    });
    it('skips (changing nothing) when the item is no longer pending', async () => {
      const { repo, items } = await setup(1);
      await repo.markOutbox(items[0].id, { status: 'superseded' });
      const before = await repo.getPending('t1');
      expect(await parkForPermission('t1', items[0].id, { repo })).toBe('skipped');
      expect(await status(repo, items[0].id)).toBe('superseded');
      expect(await repo.getPending('t1')).toEqual(before);
    });
    it('skips (changing nothing) when the txn is no longer new', async () => {
      for (const state of ['created', 'submitted', 'ignored', 'failed'] as const) {
        const { repo, items } = await setup(1);
        const handled = { ...(await repo.getPending('t1'))!, state, createdDocs: [{ doctype: 'Journal Entry', name: 'JV-1', docstatus: 0 }] };
        await repo.upsertPending(handled);
        expect(await parkForPermission('t1', items[0].id, { repo })).toBe('skipped');
        expect(await status(repo, items[0].id)).toBe('pending');
        expect(await repo.getPending('t1')).toEqual(handled);
      }
    });
    it('skips a missing item or one of another txn', async () => {
      const { repo, items } = await setup(2);
      expect(await parkForPermission('t1', 'nope', { repo })).toBe('skipped');
      expect(await parkForPermission('t1', items[1].id, { repo })).toBe('skipped');
      expect(await status(repo, items[1].id)).toBe('pending');
    });
  });

  it('never passes userAction to runPlan', async () => {
    const spy = jest.spyOn(runner, 'runPlan');
    try {
      const { erp, deps } = await setup(3);
      erp.failFor.UTR2 = { error: new ErpValidationError('nope', 417) };
      await drainOutbox(deps);
      expect(spy).toHaveBeenCalledTimes(3);
      for (const call of spy.mock.calls) {
        const opts = call[3] as { userAction?: boolean } | undefined;
        expect(opts?.userAction).toBeUndefined();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('stops after 20 items with limit', async () => {
    const { deps } = await setup(21);
    expect(await drainOutbox(deps)).toEqual({ ran: 20, stoppedBecause: 'limit' });
    expect(await drainOutbox(deps)).toEqual({ ran: 1, stoppedBecause: 'empty' });
  });

  it('an item whose txn no longer exists is marked failed and skipped', async () => {
    const { repo, deps, items } = await setup(1);
    const ghost = txn(9);
    const plan = income(ghost);
    const gid = outboxIdFor(ghost.id, plan);
    await repo.enqueue({ id: gid, txnId: ghost.id, plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    expect(await drainOutbox(deps)).toEqual({ ran: 2, stoppedBecause: 'empty' });
    expect(await status(repo, gid)).toBe('failed');
    expect(await status(repo, items[0].id)).toBe('done');
  });
});
