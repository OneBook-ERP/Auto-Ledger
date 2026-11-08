import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { planAction, txnReference, type PlanContext } from '../core/plan';
import type { ActionPlan, OutboxOp, PartyRef, PendingTxn } from '../core/types';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import { NotDraftError } from '../erp/docs';
import type { ErpOps } from './erpOps';
import { outboxIdFor, referenceOf, runPlan } from './runner';

// ---------- fixtures ----------

const txn = (over: Partial<PendingTxn> = {}): PendingTxn => ({
  id: 't1', mergedCount: 1, state: 'new', createdDocs: [], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 1234500, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: '10:30', accountType: 'bank', accountLast4: '3455',
  counterparty: 'ACME TRADERS', utr: 'UTR123', merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1762300000000, rawHash: 'h1', ...over,
});

const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  company: 'Atom Ltd',
  account: { bankAccount: 'IDFC CA', glAccount: 'IDFC CA - AL', kind: 'bank', senderIds: ['IDFCFB'], last4: ['3455'], modeOfPayment: 'Bank Draft' },
  drawingsAccount: 'Drawings - AL', today: '2026-11-08', ...over,
});

const ACME: PartyRef = { doctype: 'Customer', name: 'Acme Traders' };
const advance = (t: PendingTxn) => planAction(t, { type: 'customer_advance', party: ACME }, ctx());
const advanceNewParty = (t: PendingTxn) =>
  planAction(t, { type: 'customer_advance', party: ACME }, ctx({ newParty: { ref: ACME, fields: { customer_name: 'Acme Traders', customer_type: 'Company' } } }));
const income = (t: PendingTxn) => planAction(t, { type: 'other_income', incomeAccount: 'Interest - AL' }, ctx());

// ---------- fake ERP ----------

type Doc = { doctype: string; name: string; docstatus: number; body: Record<string, unknown> };
type OpName = keyof ErpOps;

type Party = PartyRef & { displayName: string };
const displayOf = (f: Record<string, unknown>) =>
  String(f.customer_name ?? f.supplier_name ?? f.employee_name ?? [f.first_name, f.last_name].filter(Boolean).join(' '));

class FakeErp implements ErpOps {
  docs: Doc[] = [];
  parties: Party[] = [];
  /** Series naming: the party `name` is CUST-0001 / SUPP-0001 / HR-EMP-0001, not its display name. */
  seriesNaming = false;
  private partySeq = 0;
  calls: { op: OpName; args: unknown[] }[] = [];
  /** Queue of errors thrown by the next call(s) of an operation. */
  private failures: { op: OpName; error: Error; afterEffect?: boolean }[] = [];
  delayMs = 0;
  private seq = 0;

  failNext(op: OpName, error: Error, opts: { afterEffect?: boolean } = {}) {
    this.failures.push({ op, error, afterEffect: opts.afterEffect });
  }
  count(op: OpName) { return this.calls.filter((c) => c.op === op).length; }

  private async enter(op: OpName, args: unknown[]): Promise<{ error: Error; afterEffect?: boolean } | null> {
    this.calls.push({ op, args });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const i = this.failures.findIndex((f) => f.op === op);
    if (i < 0) return null;
    const [f] = this.failures.splice(i, 1);
    if (!f.afterEffect) throw f.error;
    return f;
  }

  async findDraftByUtr(reference: string) {
    await this.enter('findDraftByUtr', [reference]);
    for (const [doctype, field] of [['Payment Entry', 'reference_no'], ['Journal Entry', 'cheque_no']]) {
      const d = this.docs.find((x) => x.doctype === doctype && x.docstatus !== 2 && x.body[field] === reference);
      if (d) return { doctype: d.doctype, name: d.name, docstatus: d.docstatus };
    }
    return null;
  }
  async createDraft(doctype: string, body: Record<string, unknown>) {
    const f = await this.enter('createDraft', [doctype, body]);
    const prefix = doctype === 'Payment Entry' ? 'ACC-PAY' : 'ACC-JV';
    const name = `${prefix}-${String(++this.seq).padStart(4, '0')}`;
    this.docs.push({ doctype, name, docstatus: 0, body: { ...body } });
    if (f) throw f.error; // the server did the work but the reply was lost
    return { name };
  }
  async deleteDraft(doctype: string, name: string) {
    await this.enter('deleteDraft', [doctype, name]);
    const d = this.docs.find((x) => x.doctype === doctype && x.name === name);
    if (!d) throw new ErpValidationError('not found', 404);
    if (d.docstatus !== 0) throw new NotDraftError(doctype, name, d.docstatus);
    this.docs = this.docs.filter((x) => x !== d);
  }
  async searchParties(doctype: PartyRef['doctype'], q: string) {
    await this.enter('searchParties', [doctype, q]);
    const lq = q.toLowerCase();
    return this.parties
      .filter((p) => p.doctype === doctype && (p.name.toLowerCase().includes(lq) || p.displayName.toLowerCase().includes(lq)))
      .map((p) => ({ ...p }));
  }
  async createParty(doctype: PartyRef['doctype'], fields: Record<string, unknown>) {
    const f = await this.enter('createParty', [doctype, fields]);
    const displayName = displayOf(fields);
    const prefix = { Customer: 'CUST', Supplier: 'SUPP', Employee: 'HR-EMP' }[doctype];
    const name = this.seriesNaming ? `${prefix}-${String(++this.partySeq).padStart(4, '0')}` : displayName;
    this.parties.push({ doctype, name, displayName });
    if (f) throw f.error;
    return { doctype, name };
  }
}

// Snapshot of the outbox row the runner owns, read straight from the test DB.
async function setup(t: PendingTxn = txn()) {
  const driver = createTestDriver();
  const repo = await createRepo(driver);
  await repo.upsertPending(t);
  const erp = new FakeErp();
  const outbox = async (): Promise<OutboxOp[]> => {
    const rows = await driver.all<{ id: string; txn_id: string; plan: string; progress: string; attempts: number; status: OutboxOp['status'] }>(
      'SELECT id, txn_id, plan, progress, attempts, status FROM outbox ORDER BY seq');
    return rows.map((r) => ({ id: r.id, txnId: r.txn_id, plan: JSON.parse(r.plan), progress: JSON.parse(r.progress), attempts: r.attempts, status: r.status }));
  };
  return { repo, erp, outbox, deps: { repo, erp } };
}

/** A view of the same database through a fresh Repo object: models an app restart. */
const restarted = (repo: Repo): Repo => ({ ...repo });

// ---------- tests ----------

describe('referenceOf', () => {
  it('reads reference_no from a Payment Entry and cheque_no from a Journal Entry', () => {
    const t = txn();
    expect(referenceOf(advance(t).steps[0])).toBe('UTR123');
    expect(referenceOf(income(t).steps[0])).toBe('UTR123');
    const noUtr = txn({ utr: null, rawHash: 'abc' });
    expect(referenceOf(advance(noUtr).steps[0])).toBe(txnReference(noUtr));
  });
  it('is null for party steps and documents without a reference', () => {
    expect(referenceOf(advanceNewParty(txn()).steps[0])).toBeNull();
    expect(referenceOf({ kind: 'create_doc', doctype: 'Payment Entry', body: {} })).toBeNull();
    expect(referenceOf({ kind: 'create_doc', doctype: 'Payment Entry', body: { reference_no: '  ' } })).toBeNull();
  });
});

describe('runPlan: success (f)', () => {
  it('creates the draft, records it on the txn and marks the outbox item done', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    const r = await runPlan('t1', plan, deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('findDraftByUtr')).toBe(1);
    expect(erp.calls.find((c) => c.op === 'findDraftByUtr')!.args).toEqual(['UTR123']);
    expect(erp.count('createDraft')).toBe(1);
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('created');
    expect(saved!.error).toBeNull();
    expect(saved!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    const ob = await outbox();
    expect(ob).toHaveLength(1);
    expect(ob[0]).toMatchObject({ id: outboxIdFor('t1', plan), txnId: 't1', status: 'done', progress: { stepIndex: 1, created: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] } });
  });

  it('keeps all other txn fields untouched (R32 replace by id)', async () => {
    const t = txn({ mergedCount: 3, balanceMinor: 42 });
    const { repo, deps } = await setup(t);
    await runPlan('t1', advance(t), deps);
    const saved = await repo.getPending('t1');
    expect({ ...saved, state: t.state, createdDocs: [], error: null }).toEqual(t);
  });

  it('throws a clear Error when the txn does not exist', async () => {
    const { deps, erp } = await setup();
    await expect(runPlan('nope', advance(txn()), deps)).rejects.toThrow(/nope.*not found|not found.*nope/i);
    expect(erp.calls).toHaveLength(0);
  });

  it('a txn already created returns its documents and calls nothing', async () => {
    const t = txn({ state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-9', docstatus: 0 }] });
    const { erp, deps } = await setup(t);
    const r = await runPlan('t1', advance(t), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-9' }] });
    expect(erp.calls).toHaveLength(0);
  });
});

describe('runPlan: idempotent retry (a)', () => {
  it('a findDraftByUtr hit is used and nothing is created', async () => {
    const { repo, erp, outbox, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0, body: { reference_no: 'UTR123' } });
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-OLD' }] });
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0 }]);
    expect((await outbox())[0].status).toBe('done');
  });

  it('a hit already submitted by the accountant (docstatus 1) is reported with docstatus 1', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Journal Entry', name: 'JV-1', docstatus: 1, body: { cheque_no: 'UTR123' } });
    const r = await runPlan('t1', income(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Journal Entry', name: 'JV-1' }] });
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Journal Entry', name: 'JV-1', docstatus: 1 }]);
  });

  it('running the same plan twice in sequence creates one document', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advance(txn());
    const r1 = await runPlan('t1', plan, deps);
    // Even if the txn were reset (e.g. the state write was lost), the server lookup prevents a duplicate.
    await repo.upsertPending({ ...(await repo.getPending('t1'))!, state: 'new', createdDocs: [] });
    const r2 = await runPlan('t1', plan, deps);
    expect(r2).toEqual(r1);
    expect(erp.count('createDraft')).toBe(1);
    expect(erp.docs).toHaveLength(1);
  });

  it('crash between create and persistence: the retry finds the document', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    // Server created the draft, but the reply never arrived (connection dropped).
    erp.failNext('createDraft', new ErpNetworkError('Could not reach the ERPNext site.'), { afterEffect: true });
    const r1 = await runPlan('t1', plan, deps);
    expect(r1).toMatchObject({ status: 'failed', retryable: true });
    expect(erp.docs).toHaveLength(1);
    const r2 = await runPlan('t1', plan, { repo: restarted(repo), erp });
    expect(r2).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(1);
    expect((await repo.getPending('t1'))!.state).toBe('created');
    expect((await outbox())[0].status).toBe('done');
  });

  it('crash after a successful create (progress never saved) does not duplicate', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advance(txn());
    // Simulate the previous process: the fake created the doc, then the app died before any write.
    await erp.createDraft('Payment Entry', plan.steps[0].body);
    const r = await runPlan('t1', plan, { repo: restarted(repo), erp });
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(1);
  });
});

describe('runPlan: partial failure (b)', () => {
  it('persists the created party and a retry reuses it (same process)', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advanceNewParty(txn());
    expect(plan.steps.map((s) => s.kind)).toEqual(['create_party', 'create_doc']);
    erp.failNext('createDraft', new ErpValidationError('Value missing for Payment Entry: Cost Center', 417, ['Cost Center']));
    const r1 = await runPlan('t1', plan, deps);
    expect(r1).toMatchObject({ status: 'failed', retryable: false });
    expect(erp.parties).toEqual([{ ...ACME, displayName: 'Acme Traders' }]);
    expect(erp.count('deleteDraft')).toBe(0); // parties are master data, never deleted
    const ob = await outbox();
    expect(ob[0].progress).toEqual({ stepIndex: 1, created: [{ doctype: 'Customer', name: 'Acme Traders' }] });
    expect(ob[0].status).toBe('failed');

    const r2 = await runPlan('t1', plan, deps);
    expect(r2).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createParty')).toBe(1);
    expect(erp.parties).toHaveLength(1);
    expect((await outbox())[0]).toMatchObject({ status: 'done', progress: { stepIndex: 2 } });
  });

  it('after a restart the retry reads the stored progress and reuses the party', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advanceNewParty(txn());
    erp.failNext('createDraft', new ErpValidationError('rejected', 417));
    await runPlan('t1', plan, deps);
    const searches = erp.count('searchParties');
    const r2 = await runPlan('t1', plan, { repo: restarted(repo), erp });
    expect(r2.status).toBe('created');
    expect(erp.count('createParty')).toBe(1);
    expect(erp.count('searchParties')).toBe(searches); // progress from getOutbox, no search needed
  });

  describe.each([
    ['Employee', () => {
      const t = txn({ kind: 'ca_debit', direction: 'out' });
      const ravi: PartyRef = { doctype: 'Employee', name: 'Ravi Kumar' };
      return { t, plan: planAction(t, { type: 'salary', party: ravi }, ctx({ newParty: { ref: ravi, fields: { first_name: 'Ravi', last_name: 'Kumar', gender: 'Male' } } })), series: 'HR-EMP-0001' };
    }],
    ['Customer', () => ({ t: txn(), plan: advanceNewParty(txn()), series: 'CUST-0001' })],
  ] as const)('series-named %s', (_dt, make) => {
    it('a lost create reply is not followed by a second party', async () => {
      const { t, plan, series } = make();
      const { erp, deps } = await setup(t);
      erp.seriesNaming = true;
      erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
      expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: true });
      expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'created' });
      expect(erp.parties).toHaveLength(1);
      expect(erp.count('createParty')).toBe(1);
      expect(erp.docs[0].body.party).toBe(series);
    });

    it('a crash before the progress write is not followed by a second party', async () => {
      const { t, plan, series } = make();
      const { repo, erp } = await setup(t);
      erp.seriesNaming = true;
      let crash = true;
      const crashing: Repo = {
        ...repo,
        async markOutbox(id, patch) {
          // The process dies right after the party create: no later write of this run lands.
          if (crash && patch.progress && patch.progress.stepIndex >= 1) throw new Error('process killed');
          return repo.markOutbox(id, patch);
        },
      };
      await expect(runPlan('t1', plan, { repo: crashing, erp })).rejects.toThrow('process killed');
      crash = false;
      expect(erp.parties).toHaveLength(1);
      expect((await repo.getOutbox(outboxIdFor('t1', plan)))!.progress.stepIndex).toBe(0);
      expect(await runPlan('t1', plan, { repo: restarted(repo), erp })).toMatchObject({ status: 'created' });
      expect(erp.count('createParty')).toBe(1);
      expect(erp.docs).toHaveLength(1);
      expect(erp.docs[0].body.party).toBe(series);
    });
  });

  it('a party that already exists by exact name is reused, not created', async () => {
    const { erp, deps } = await setup();
    erp.parties.push({ doctype: 'Customer', name: 'Acme Traders Pvt', displayName: 'Acme Traders Pvt' }, { ...ACME, displayName: 'Acme Traders' });
    const r = await runPlan('t1', advanceNewParty(txn()), deps);
    expect(r.status).toBe('created');
    expect(erp.count('createParty')).toBe(0);
    expect(erp.docs[0].body.party).toBe('Acme Traders');
  });

  it('a party whose create reply was lost is found on retry', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advanceNewParty(txn());
    erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(await runPlan('t1', plan, { repo: restarted(repo), erp })).toMatchObject({ status: 'created' });
    expect(erp.parties).toHaveLength(1);
  });

  it('uses the name ERPNext assigned to the new party in the document', async () => {
    const { erp, deps } = await setup();
    erp.createParty = async (doctype, fields) => {
      erp.calls.push({ op: 'createParty', args: [doctype, fields] });
      erp.parties.push({ doctype, name: 'CUST-00042', displayName: 'Acme Traders' });
      return { doctype, name: 'CUST-00042' };
    };
    await runPlan('t1', advanceNewParty(txn()), deps);
    expect(erp.docs[0].body.party).toBe('CUST-00042');
  });
});

describe('runPlan: compensation (c)', () => {
  // The planner only ever emits one document; a two-document plan exercises compensation.
  const twoDocs = (t: PendingTxn): ActionPlan => {
    const a = advance(t).steps[0];
    const b = income(txn({ utr: 'UTR999' })).steps[0];
    return { steps: [a, b], summary: ['a', 'b'], needsInrAmount: false };
  };

  it('deletes drafts created by this run, resets the txn with a readable error and fails the item', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const err = new ErpValidationError('Value missing for Journal Entry: Gender', 417, ['Gender']);
    erp.createDraft = (orig => async (doctype: string, body: Record<string, unknown>) => {
      if (doctype === 'Journal Entry') { erp.calls.push({ op: 'createDraft', args: [doctype, body] }); throw err; }
      return orig(doctype, body);
    })(erp.createDraft.bind(erp));
    const r = await runPlan('t1', twoDocs(txn()), deps);
    expect(r).toEqual({ status: 'failed', error: err, retryable: false });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0001']]);
    expect(erp.docs).toHaveLength(0);
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('new');
    expect(saved!.createdDocs).toEqual([]);
    expect(saved!.error).toMatch(/ERPNext needs these fields: Gender/);
    expect(saved!.error).toMatch(/complete .*in ERPNext/i);
    expect((await outbox())[0].status).toBe('failed');
  });

  it('surfaces a closed accounting period', async () => {
    const { repo, erp, deps } = await setup();
    erp.failNext('createDraft', new ErpValidationError('Cannot create entries in a closed accounting period', 417, undefined, true));
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect((await repo.getPending('t1'))!.error).toMatch(/The accounting period is closed for this date/);
  });

  it('a plain validation error keeps the server message', async () => {
    const { repo, erp, deps } = await setup();
    erp.failNext('createDraft', new ErpValidationError('Paid Amount cannot be zero', 417));
    await runPlan('t1', advance(txn()), deps);
    expect((await repo.getPending('t1'))!.error).toMatch(/Paid Amount cannot be zero/);
  });

  it('does not delete a document found by reference (not created by this run)', async () => {
    const { erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0, body: { reference_no: 'UTR123' } });
    erp.failNext('createDraft', new ErpValidationError('nope', 417));
    await runPlan('t1', twoDocs(txn()), deps);
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-OLD']);
  });

  it('a NotDraftError during compensation is recorded, not thrown, and the doc stays in createdDocs', async () => {
    const { repo, erp, deps } = await setup();
    let n = 0;
    const orig = erp.createDraft.bind(erp);
    erp.createDraft = async (doctype, body) => {
      if (++n === 2) { erp.calls.push({ op: 'createDraft', args: [doctype, body] }); throw new ErpValidationError('bad', 417); }
      const res = await orig(doctype, body);
      erp.docs.find((d) => d.name === res.name)!.docstatus = 1; // the accountant submitted it meanwhile
      return res;
    };
    const r = await runPlan('t1', twoDocs(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('new');
    expect(saved!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    expect(saved!.error).toMatch(/ACC-PAY-0001/);
    expect(saved!.error).toMatch(/no longer a draft/);
  });
});

describe('runPlan: auth (d)', () => {
  it('needs_login keeps the item pending, compensates nothing and leaves the txn new', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advanceNewParty(txn());
    erp.failNext('createDraft', new ErpAuthError('ERPNext did not accept the credentials.', 401));
    const r = await runPlan('t1', plan, deps);
    expect(r).toEqual({ status: 'needs_login' });
    expect(erp.count('deleteDraft')).toBe(0);
    const ob = (await outbox())[0];
    expect(ob.status).toBe('pending');
    expect(ob.attempts).toBe(0);
    expect(ob.progress).toEqual({ stepIndex: 1, created: [{ doctype: 'Customer', name: 'Acme Traders' }] });
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('new');
    expect(saved!.error).toBeNull();
    // After signing in the queued work completes without a second party.
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'created' });
    expect(erp.count('createParty')).toBe(1);
  });

  it('403 on the lookup is also needs_login', async () => {
    const { erp, outbox, deps } = await setup();
    erp.failNext('findDraftByUtr', new ErpAuthError('not allowed', 403, 'Payment Entry'));
    expect(await runPlan('t1', advance(txn()), deps)).toEqual({ status: 'needs_login' });
    expect((await outbox())[0].status).toBe('pending');
  });
});

describe('runPlan: network (e)', () => {
  it('is retryable, keeps the item pending and increments attempts', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    const err = new ErpNetworkError('Could not reach the ERPNext site. Check your connection and try again.');
    erp.failNext('findDraftByUtr', err);
    expect(await runPlan('t1', plan, deps)).toEqual({ status: 'failed', error: err, retryable: true });
    erp.failNext('findDraftByUtr', err);
    await runPlan('t1', plan, deps);
    const ob = (await outbox())[0];
    expect(ob.status).toBe('pending');
    expect(ob.attempts).toBe(2);
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });

  it('after a restart, a failure keeps the stored progress and counts on from the stored attempts', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advanceNewParty(txn());
    erp.failNext('createDraft', new ErpValidationError('bad', 417));
    await runPlan('t1', plan, deps); // item failed, progress {1, [party]}, attempts 1
    erp.failNext('findDraftByUtr', new ErpNetworkError('down'));
    expect(await runPlan('t1', plan, { repo: restarted(repo), erp })).toMatchObject({ status: 'failed', retryable: true });
    const ob = (await outbox())[0];
    expect(ob.status).toBe('pending');
    expect(ob.attempts).toBe(2);
    expect(ob.progress).toEqual({ stepIndex: 1, created: [{ doctype: 'Customer', name: 'Acme Traders' }] });
  });

  it('does not delete a document created earlier in the run', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn()).steps[0];
    const b = income(txn({ utr: 'UTR999' })).steps[0];
    const plan: ActionPlan = { steps: [a, b], summary: [], needsInrAmount: false };
    let n = 0;
    const orig = erp.createDraft.bind(erp);
    erp.createDraft = async (d, body) => { if (++n === 2) throw new ErpNetworkError('timeout'); return orig(d, body); };
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001']);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    // Retry: the first doc is found, only the second is created.
    expect(await runPlan('t1', plan, { repo: restarted(repo), erp })).toMatchObject({ status: 'created' });
    expect(erp.docs).toHaveLength(2);
  });

  it('an unexpected (non-ERP) error is a retryable network-class failure without leaking its text', async () => {
    const { erp, outbox, deps } = await setup();
    erp.failNext('createDraft', new Error('token abc:SECRET leaked'));
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r.status).toBe('failed');
    if (r.status !== 'failed') return;
    expect(r.error).toBeInstanceOf(ErpNetworkError);
    expect(r.retryable).toBe(true);
    expect(r.error.message).not.toMatch(/SECRET/);
    expect((await outbox())[0].status).toBe('pending');
  });
});

describe('runPlan: never submit (g) and plan guards', () => {
  it.each([1, 2, '1'])('refuses a step body with docstatus %p and calls nothing', async (ds) => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    plan.steps[0].body.docstatus = ds;
    const r = await runPlan('t1', plan, deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') {
      expect(r.error).toBeInstanceOf(ErpValidationError);
      expect(r.error.message).toMatch(/draft/i);
    }
    expect(erp.calls).toHaveLength(0);
    expect((await repo.getPending('t1'))!.state).toBe('new');
    expect((await outbox())[0].status).toBe('failed');
  });

  it('accepts an explicit docstatus 0', async () => {
    const { erp, deps } = await setup();
    const plan = advance(txn());
    plan.steps[0].body.docstatus = 0;
    expect((await runPlan('t1', plan, deps)).status).toBe('created');
    expect(erp.docs[0].docstatus).toBe(0);
  });

  it('refuses a document step without a reference (no idempotency key)', async () => {
    const { erp, deps } = await setup();
    const plan = advance(txn());
    delete plan.steps[0].body.reference_no;
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: false });
    expect(erp.calls).toHaveLength(0);
  });

  it('refuses a plan that still needs the INR amount', async () => {
    const t = txn({ currency: 'USD' });
    const { repo, erp, deps } = await setup(t);
    const plan = planAction(t, { type: 'customer_advance', party: ACME }, ctx());
    expect(plan.needsInrAmount).toBe(true);
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: false });
    expect(erp.calls).toHaveLength(0);
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });

  it('refuses unsupported doctypes', async () => {
    const { erp, deps } = await setup();
    const plan: ActionPlan = { steps: [{ kind: 'create_doc', doctype: 'Sales Invoice', body: { reference_no: 'X' } }], summary: [], needsInrAmount: false };
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: false });
    expect(erp.calls).toHaveLength(0);
  });
});

describe('runPlan: ignore (h)', () => {
  it('an empty plan marks the txn ignored and the item done', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = planAction(txn(), { type: 'ignore' }, ctx());
    expect(await runPlan('t1', plan, deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.calls).toHaveLength(0);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
    expect((await outbox())[0].status).toBe('done');
  });
});

describe('runPlan: concurrency (i)', () => {
  it('two parallel runs of the same txn create one document', async () => {
    const { repo, erp, deps } = await setup();
    erp.delayMs = 5;
    const plan = advance(txn());
    const [r1, r2] = await Promise.all([runPlan('t1', plan, deps), runPlan('t1', plan, deps)]);
    expect(r1).toEqual(r2);
    expect(r1.status).toBe('created');
    expect(erp.count('createDraft')).toBe(1);
    expect(erp.docs).toHaveLength(1);
    expect((await repo.getPending('t1'))!.createdDocs).toHaveLength(1);
  });

  it('parallel runs through different Repo objects are still serialised', async () => {
    const { repo, erp } = await setup();
    erp.delayMs = 5;
    const plan = advanceNewParty(txn());
    await Promise.all([runPlan('t1', plan, { repo, erp }), runPlan('t1', plan, { repo: restarted(repo), erp })]);
    expect(erp.count('createParty')).toBe(1);
    expect(erp.count('createDraft')).toBe(1);
  });

  it('a failing run releases the lock', async () => {
    const { erp, deps } = await setup();
    erp.failNext('findDraftByUtr', new ErpNetworkError('x'));
    const plan = advance(txn());
    const [a, b] = await Promise.all([runPlan('t1', plan, deps), runPlan('t1', plan, deps)]);
    expect(a.status).toBe('failed');
    expect(b.status).toBe('created');
  });
});

describe('runPlan: outbox identity', () => {
  it('a different plan for the same txn gets its own outbox item', async () => {
    const { erp, outbox, deps } = await setup();
    erp.failNext('createDraft', new ErpValidationError('bad', 417));
    await runPlan('t1', advance(txn()), deps);
    await runPlan('t1', income(txn()), deps);
    const ob = await outbox();
    expect(ob.map((o) => o.status)).toEqual(['failed', 'done']);
    expect(new Set(ob.map((o) => o.id)).size).toBe(2);
  });

  it('works with an outbox item enqueued by the caller under outboxIdFor', async () => {
    const { repo, outbox, deps } = await setup();
    const plan = advance(txn());
    await repo.enqueue({ id: outboxIdFor('t1', plan), txnId: 't1', plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    expect((await runPlan('t1', plan, deps)).status).toBe('created');
    expect(await outbox()).toHaveLength(1);
    expect((await outbox())[0].status).toBe('done');
  });
});

describe('runPlan: secrets (j)', () => {
  it('never logs', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const { erp, deps } = await setup();
    erp.failNext('createDraft', new ErpValidationError('bad', 417, ['Gender']));
    await runPlan('t1', advance(txn()), deps);
    for (const s of spies) { expect(s).not.toHaveBeenCalled(); s.mockRestore(); }
  });
});

async function drain(repo: Repo, erp: ErpOps): Promise<string[]> {
  const ran: string[] = [];
  for (let op = await repo.nextOutbox(); op; op = await repo.nextOutbox()) {
    ran.push(op.id);
    await runPlan(op.txnId, op.plan, { repo, erp });
  }
  return ran;
}

describe('runPlan: superseded plans (I2)', () => {
  it('a queued plan does not run after the user chose Ignore', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const a = advance(txn());
    erp.failNext('findDraftByUtr', new ErpNetworkError('offline'));
    expect(await runPlan('t1', a, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
    expect(await drain(repo, erp)).toEqual([]); // A was superseded when Ignore was enqueued
    // Even when the drainer (or anyone) runs A directly, nothing is created.
    const r = await runPlan('t1', a, deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    expect((await outbox()).map((o) => o.status)).toEqual(['superseded', 'done']);
  });

  it('a pending plan on a txn that is no longer new is superseded by the drainer', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    erp.failNext('findDraftByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', a, deps);
    await repo.upsertPending({ ...(await repo.getPending('t1'))!, state: 'ignored' });
    expect(await drain(repo, erp)).toEqual([outboxIdFor('t1', a)]);
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
  });

  it('a newer plan supersedes the older pending one and only the newer runs', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    const b = income(txn());
    erp.failNext('findDraftByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', a, deps);
    erp.failNext('findDraftByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', b, deps);
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    expect(await drain(repo, erp)).toEqual([outboxIdFor('t1', b)]);
    expect(erp.docs.map((d) => d.doctype)).toEqual(['Journal Entry']);
    expect((await repo.getPending('t1'))!.state).toBe('created');
  });
});

describe('runPlan: reference hit of another doctype (I3)', () => {
  it.each([
    ['Payment Entry', 'reference_no', income],
    ['Journal Entry', 'cheque_no', advance],
  ] as const)('a %s hit for a different step doctype fails without creating', async (doctype, field, make) => {
    const { repo, erp, outbox, deps } = await setup();
    erp.docs.push({ doctype, name: 'OLD-1', docstatus: 0, body: { [field]: 'UTR123' } });
    const r = await runPlan('t1', make(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') {
      expect(r.error).toBeInstanceOf(ErpValidationError);
      expect(r.error.message).toMatch(/An entry OLD-1 .*already exists for this reference; open it in ERPNext or delete it, then try again/);
    }
    expect(erp.count('createDraft')).toBe(0);
    expect(erp.count('deleteDraft')).toBe(0);
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('new');
    expect(saved!.createdDocs).toEqual([]);
    expect(saved!.error).toMatch(/An entry OLD-1 .*already exists for this reference/);
    expect((await outbox())[0].status).toBe('failed');
  });
});

describe('runPlan: final write order (I4)', () => {
  it('a crash between the txn write and the outbox done write recovers without creating', async () => {
    const { repo, erp, outbox } = await setup();
    const plan = advance(txn());
    let crash = true;
    const crashing: Repo = {
      ...repo,
      async markOutbox(id, patch) {
        if (crash && patch.status === 'done') { crash = false; throw new Error('process killed'); }
        return repo.markOutbox(id, patch);
      },
    };
    await expect(runPlan('t1', plan, { repo: crashing, erp })).rejects.toThrow('process killed');
    expect((await repo.getPending('t1'))!.state).toBe('created');
    expect((await outbox())[0].status).toBe('pending');
    expect(await drain(repo, erp)).toEqual([outboxIdFor('t1', plan)]);
    expect(erp.count('createDraft')).toBe(1);
    expect((await outbox())[0].status).toBe('done');
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('created');
    expect(saved!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
  });
});
