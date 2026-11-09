import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { planAction, txnReference, type PlanContext } from '../core/plan';
import type { ActionPlan, OutboxOp, PartyRef, PendingTxn } from '../core/types';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import { NotDraftError } from '../erp/docs';
import type { ErpOps } from './erpOps';
import { outboxIdFor, referenceOf, runPlan as rawRunPlan, undoTxn, type RunOptions } from './runner';

// Most tests act as the UI (the user's decision); the drainer path calls rawRunPlan without options.
const runPlan = (txnId: string, plan: ActionPlan, deps: { repo: Repo; erp: ErpOps }, opts: RunOptions = { userAction: true }) =>
  rawRunPlan(txnId, plan, deps, opts);

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
const RAVI: PartyRef = { doctype: 'Employee', name: 'Ravi Kumar' };
const salaryNewEmployee = (t: PendingTxn, fields: Record<string, unknown> = { first_name: 'Ravi', last_name: 'Kumar', gender: 'Male' }) =>
  planAction(t, { type: 'salary', party: RAVI }, ctx({ newParty: { ref: RAVI, fields } }));
const income = (t: PendingTxn) => planAction(t, { type: 'other_income', incomeAccount: 'Interest - AL' }, ctx());
const ICICI = { bankAccount: 'ICICI CA', glAccount: 'ICICI CA - AL', kind: 'bank' as const, senderIds: ['ICICIB'], last4: ['9001'], modeOfPayment: 'Wire Transfer' };
/** Outgoing leg of an own-account transfer IDFC -> ICICI. */
const transferOut = (t: PendingTxn) => planAction(t, { type: 'transfer', toAccount: ICICI }, ctx());
/**
 * The incoming leg on ICICI, as the planner books it from that side: the SAME Internal Transfer Payment Entry
 * (paid_from IDFC, paid_to ICICI, same amount and reference), with its own remarks and mode of payment.
 */
const transferLeg2 = (t: PendingTxn, over: Record<string, unknown> = {}): ActionPlan => {
  const out = transferOut({ ...t, kind: 'ca_debit', direction: 'out' });
  const step = out.steps[0];
  return { ...out, steps: [{ ...step, body: { ...step.body, mode_of_payment: 'Wire Transfer', remarks: 'AutoLedger | incoming leg', ...over } }] };
};

// ---------- fake ERP ----------

type Doc = { doctype: string; name: string; docstatus: number; body: Record<string, unknown> };
type OpName = keyof ErpOps;

type Party = PartyRef & { displayName: string };
// Like ERPNext: an Employee's employee_name is always first + middle + last.
const displayOf = (doctype: string, f: Record<string, unknown>) =>
  doctype === 'Employee'
    ? [f.first_name, f.middle_name, f.last_name].filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()).join(' ')
    : String(f.customer_name ?? f.supplier_name);

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

  // Like the server: every non-cancelled hit, Payment Entries first, each in creation order.
  async findDraftsByUtr(reference: string) {
    await this.enter('findDraftsByUtr', [reference]);
    const out: { doctype: string; name: string; docstatus: number }[] = [];
    for (const [doctype, field] of [['Payment Entry', 'reference_no'], ['Journal Entry', 'cheque_no']]) {
      for (const d of this.docs) {
        if (d.doctype === doctype && d.docstatus !== 2 && d.body[field] === reference) out.push({ doctype: d.doctype, name: d.name, docstatus: d.docstatus });
      }
    }
    return out;
  }
  async getDraftSummary(doctype: string, name: string) {
    await this.enter('getDraftSummary', [doctype, name]);
    const d = this.docs.find((x) => x.doctype === doctype && x.name === name);
    if (!d) throw new ErpValidationError('not found', 404);
    const b = d.body;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const minor = (v: unknown) => (typeof v === 'number' ? Math.round(v * 100) : null);
    const rows = Array.isArray(b.accounts) ? (b.accounts as Record<string, unknown>[]) : [];
    return {
      doctype, name, docstatus: d.docstatus, company: str(b.company), paymentType: str(b.payment_type), paidFrom: str(b.paid_from), paidTo: str(b.paid_to),
      paidAmountMinor: minor(b.paid_amount), partyType: str(b.party_type), party: str(b.party),
      totalDebitMinor: rows.length ? rows.reduce((t, r) => t + (minor(r.debit_in_account_currency) ?? 0), 0) : null,
      accounts: rows.map((r) => ({
        account: str(r.account), debitMinor: minor(r.debit_in_account_currency) ?? 0, creditMinor: minor(r.credit_in_account_currency) ?? 0,
        partyType: str(r.party_type), party: str(r.party),
      })),
    };
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
  async searchParties(doctype: PartyRef['doctype'], q: string, exact?: boolean) {
    await this.enter('searchParties', exact ? [doctype, q, true] : [doctype, q]);
    const lq = q.toLowerCase();
    return this.parties
      .filter((p) => p.doctype === doctype && (exact
        ? p.displayName.toLowerCase() === lq
        : p.name.toLowerCase().includes(lq) || p.displayName.toLowerCase().includes(lq)))
      .slice(0, 20) // like the server's limit_page_length
      .map((p) => ({ ...p }));
  }
  async getDocStatuses(refs: { doctype: string; name: string }[]) {
    await this.enter('getDocStatuses', [refs]);
    const out: Record<string, number> = {};
    for (const r of refs) {
      const d = this.docs.find((x) => x.doctype === r.doctype && x.name === r.name);
      if (d) out[`${d.doctype}:${d.name}`] = d.docstatus;
    }
    return out;
  }
  async createParty(doctype: PartyRef['doctype'], fields: Record<string, unknown>) {
    const f = await this.enter('createParty', [doctype, fields]);
    const displayName = displayOf(doctype, fields);
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
    expect(erp.count('findDraftsByUtr')).toBe(1);
    expect(erp.calls.find((c) => c.op === 'findDraftsByUtr')!.args).toEqual(['UTR123']);
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

  it('a txn already created by another decision refuses readably, calls nothing and changes nothing', async () => {
    const t = txn({ state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-9', docstatus: 0 }] });
    const { repo, erp, outbox, deps } = await setup(t);
    const r = await runPlan('t1', advance(t), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toBe('This transaction was already processed (PE-9); use Undo in Activity to change it.');
    expect(erp.calls).toHaveLength(0);
    expect(await outbox()).toEqual([]);
    expect(await repo.getPending('t1')).toEqual(t);
  });

  it('a re-run of the same plan after completion returns its own documents (idempotent)', async () => {
    const { erp, outbox, deps } = await setup();
    const plan = advance(txn());
    const r1 = await runPlan('t1', plan, deps);
    const calls = erp.calls.length;
    expect(await runPlan('t1', plan, deps)).toEqual(r1);
    expect(await rawRunPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: false }); // drainer: item is done
    expect(erp.calls.length).toBe(calls);
    expect((await outbox())[0].status).toBe('done');
  });
});

describe('runPlan: idempotent retry (a)', () => {
  it('a findDraftsByUtr hit is used and nothing is created', async () => {
    const { repo, erp, outbox, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-OLD' }] });
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0, adopted: true }]);
    expect((await outbox())[0].status).toBe('done');
  });

  it('a hit already submitted by the accountant (docstatus 1) is reported with docstatus 1', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Journal Entry', name: 'JV-1', docstatus: 1, body: { ...income(txn()).steps[0].body } });
    const r = await runPlan('t1', income(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Journal Entry', name: 'JV-1' }] });
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Journal Entry', name: 'JV-1', docstatus: 1, adopted: true }]);
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

  it('first attempt: an existing namesake is NOT reused, a new party is created', async () => {
    const { erp, deps } = await setup(txn({ kind: 'ca_debit', direction: 'out' }));
    erp.seriesNaming = true;
    erp.parties.push({ doctype: 'Employee', name: 'HR-EMP-0003', displayName: 'Ravi Kumar' });
    const r = await runPlan('t1', salaryNewEmployee(txn({ kind: 'ca_debit', direction: 'out' })), deps);
    expect(r.status).toBe('created');
    expect(erp.count('searchParties')).toBe(0);
    expect(erp.count('createParty')).toBe(1);
    expect(erp.docs[0].body.party).toBe('HR-EMP-0001');
  });

  it('retry after a lost reply reuses the party found by exact display name', async () => {
    const t = txn({ kind: 'ca_debit', direction: 'out' });
    const { erp, deps } = await setup(t);
    erp.seriesNaming = true;
    erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', salaryNewEmployee(t), deps);
    expect(await rawRunPlan('t1', salaryNewEmployee(t), deps)).toMatchObject({ status: 'created' });
    expect(erp.calls.filter((c) => c.op === 'searchParties').map((c) => c.args)).toEqual([['Employee', 'Ravi Kumar', true]]);
    expect(erp.parties).toHaveLength(1);
    expect(erp.docs[0].body.party).toBe('HR-EMP-0001');
  });

  it('two exact namesakes on a retry: refuses with a readable error and creates nothing', async () => {
    const t = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t);
    erp.seriesNaming = true;
    erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', salaryNewEmployee(t), deps);
    erp.parties.push({ doctype: 'Employee', name: 'HR-EMP-0099', displayName: 'ravi kumar' });
    const r = await rawRunPlan('t1', salaryNewEmployee(t), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toMatch(/More than one Employee is named Ravi Kumar; pick the right one in ERPNext/);
    expect(erp.count('createParty')).toBe(1);
    expect(erp.count('createDraft')).toBe(0);
    expect((await repo.getPending('t1'))!.error).toMatch(/More than one Employee is named Ravi Kumar/);
  });

  it('Employee with a middle name is found on retry (ERPNext composes employee_name)', async () => {
    const t = txn({ kind: 'ca_debit', direction: 'out' });
    const { erp, deps } = await setup(t);
    erp.seriesNaming = true;
    const plan = salaryNewEmployee(t, { first_name: 'Ravi', middle_name: 'S', last_name: 'Kumar', employee_name: 'Ravi Kumar' });
    erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', plan, deps);
    expect(erp.parties[0].displayName).toBe('Ravi S Kumar');
    expect(await rawRunPlan('t1', plan, deps)).toMatchObject({ status: 'created' });
    expect(erp.calls.filter((c) => c.op === 'searchParties').map((c) => c.args)).toEqual([['Employee', 'Ravi S Kumar', true]]);
    expect(erp.parties).toHaveLength(1);
  });

  it('a common name with more than 20 substring matches is still found on retry', async () => {
    const t = txn({ kind: 'ca_debit', direction: 'out' });
    const { erp, deps } = await setup(t);
    for (let n = 1; n <= 25; n++) erp.parties.push({ doctype: 'Employee', name: `HR-EMP-9${n}`, displayName: `Ravi Kumar ${n}` });
    erp.seriesNaming = true;
    erp.failNext('createParty', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', salaryNewEmployee(t), deps);
    expect((await erp.searchParties('Employee', 'Ravi Kumar')).map((p) => p.name)).not.toContain('HR-EMP-0001'); // substring search misses it
    expect(await rawRunPlan('t1', salaryNewEmployee(t), deps)).toMatchObject({ status: 'created' });
    expect(erp.count('createParty')).toBe(1);
    expect(erp.docs[0].body.party).toBe('HR-EMP-0001');
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
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-OLD', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
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
    erp.failNext('findDraftsByUtr', new ErpAuthError('not allowed', 403, 'Payment Entry'));
    expect(await runPlan('t1', advance(txn()), deps)).toEqual({ status: 'needs_login' });
    expect((await outbox())[0].status).toBe('pending');
  });
});

describe('runPlan: network (e)', () => {
  it('is retryable, keeps the item pending and increments attempts', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    const err = new ErpNetworkError('Could not reach the ERPNext site. Check your connection and try again.');
    erp.failNext('findDraftsByUtr', err);
    expect(await runPlan('t1', plan, deps)).toEqual({ status: 'failed', error: err, retryable: true });
    erp.failNext('findDraftsByUtr', err);
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
    erp.failNext('findDraftsByUtr', new ErpNetworkError('down'));
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
    erp.failNext('findDraftsByUtr', new ErpNetworkError('x'));
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
    await rawRunPlan(op.txnId, op.plan, { repo, erp });
  }
  return ran;
}

describe('runPlan: superseded plans (I2)', () => {
  it('a queued plan does not run after the user chose Ignore', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const a = advance(txn());
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
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
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
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
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', a, deps);
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
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
      async finishOutbox(id, progress) {
        if (crash) { crash = false; throw new Error('process killed'); }
        return repo.finishOutbox(id, progress);
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

describe('runPlan: atomic supersede through enqueue (R42.1)', () => {
  it('an item pre-enqueued by a caller supersedes the older one; nextOutbox returns only the newer', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    const b = income(txn());
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', a, deps);
    await repo.enqueue({ id: outboxIdFor('t1', b), txnId: 't1', plan: b, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
    expect(await rawRunPlan('t1', b, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect((await repo.nextOutbox())!.id).toBe(outboxIdFor('t1', b));
    expect(await drain(repo, erp)).toEqual([outboxIdFor('t1', b)]);
    expect(erp.docs.map((d) => d.doctype)).toEqual(['Journal Entry']);
  });
});

describe('runPlan: only user actions open items (R42.2)', () => {
  it('a drainer run of an item that is missing changes nothing', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const r = await rawRunPlan('t1', advance(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toBe('This action was replaced by a newer decision.');
    expect(await outbox()).toEqual([]);
    expect(erp.calls).toEqual([]);
    expect(await repo.getPending('t1')).toEqual(txn());
  });

  it('race: the drainer queued behind the user\'s newer decision bails and creates nothing', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    const b = income(txn());
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', a, deps); // A pending (retryable)
    const heldA = (await repo.nextOutbox())!; // the drainer picked A up
    expect(heldA.id).toBe(outboxIdFor('t1', a));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = erp.findDraftsByUtr.bind(erp);
    let first = true;
    erp.findDraftsByUtr = async (ref) => {
      if (first) { first = false; await gate; throw new ErpNetworkError('offline'); }
      return orig(ref);
    };
    const pB = runPlan('t1', b, deps); // holds the per-txn lock, blocked inside B's lookup
    await new Promise((r) => setTimeout(r, 5));
    const pA = rawRunPlan(heldA.txnId, heldA.plan, deps); // queued behind B on the lock
    release();
    expect(await pB).toMatchObject({ status: 'failed', retryable: true });
    const rA = await pA;
    expect(rA).toMatchObject({ status: 'failed', retryable: false });
    if (rA.status === 'failed') expect(rA.error.message).toMatch(/replaced by a newer decision/);
    expect(erp.count('createDraft')).toBe(0);
    expect(erp.docs).toEqual([]);
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    expect((await repo.getOutbox(outboxIdFor('t1', b)))!.status).toBe('pending');
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });
});

describe('runPlan: orphan drafts of replaced decisions (R42.5)', () => {
  const BETA: PartyRef = { doctype: 'Customer', name: 'Beta Ltd' };
  const advanceBeta = (t: PendingTxn) => planAction(t, { type: 'customer_advance', party: BETA }, ctx());
  const ignore = () => planAction(txn(), { type: 'ignore' }, ctx());

  async function lostReplyA() {
    const s = await setup();
    const a = advance(txn());
    s.erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t1', a, s.deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(s.erp.docs).toHaveLength(1);
    return { ...s, a };
  }

  it('Ignore after a lost-reply draft deletes it', async () => {
    const { repo, erp, deps, a } = await lostReplyA();
    expect(await runPlan('t1', ignore(), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0001']]);
    expect(erp.docs).toEqual([]);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
    const oldA = (await repo.getOutbox(outboxIdFor('t1', a)))!;
    expect(oldA.status).toBe('superseded');
    expect(oldA.progress).toEqual({ stepIndex: 0, created: [] });
  });

  it('a replacement plan of the same doctype deletes the old draft and creates its own', async () => {
    const { repo, erp, deps } = await lostReplyA();
    const r = await runPlan('t1', advanceBeta(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(erp.docs).toHaveLength(1);
    expect(erp.docs[0].body.party).toBe('Beta Ltd');
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]);
  });

  it.each([['Ignore', ignore], ['a replacement plan', () => advanceBeta(txn())]] as const)(
    'a submitted orphan blocks %s with a readable error and leaves the txn untouched',
    async (_label, make) => {
      const { repo, erp, deps } = await lostReplyA();
      erp.docs[0].docstatus = 1; // the accountant submitted it
      const before = await repo.getPending('t1');
      const r = await runPlan('t1', make(), deps);
      expect(r).toMatchObject({ status: 'failed', retryable: false });
      if (r.status === 'failed') expect(r.error.message).toBe('ACC-PAY-0001 was already submitted in ERPNext; cancel it there first.');
      expect(erp.count('deleteDraft')).toBe(0);
      expect(erp.count('createDraft')).toBe(1);
      expect(erp.docs).toHaveLength(1);
      expect(await repo.getPending('t1')).toEqual(before);
    },
  );

  it('a superseded item whose draft was never created is a no-op', async () => {
    const { erp, deps } = await setup();
    erp.failNext('findDraftsByUtr', new ErpNetworkError('offline'));
    await runPlan('t1', advance(txn()), deps); // failed before any create
    expect(await runPlan('t1', advanceBeta(txn()), deps)).toMatchObject({ status: 'created' });
    expect(erp.count('findDraftsByUtr')).toBe(2); // A's failed lookup + B's own; no orphan lookup for A
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.count('getDocStatuses')).toBe(0);
  });

  it('Ignore deletes drafts recorded on the txn instead of erasing them', async () => {
    const { repo, erp, deps } = await setup();
    const plan: ActionPlan = { steps: [advance(txn()).steps[0], income(txn({ utr: 'UTR999' })).steps[0]], summary: [], needsInrAmount: false };
    let n = 0;
    const orig = erp.createDraft.bind(erp);
    erp.createDraft = async (d, body) => { if (++n === 2) throw new ErpNetworkError('timeout'); return orig(d, body); };
    await runPlan('t1', plan, deps);
    expect((await repo.getPending('t1'))!.createdDocs).toHaveLength(1);
    expect(await runPlan('t1', ignore(), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.docs).toEqual([]);
    const saved = await repo.getPending('t1');
    expect(saved!.state).toBe('ignored');
    expect(saved!.createdDocs).toEqual([]);
  });
});

describe('runPlan: a definitive rejection clears the attempt marker (R43.1)', () => {
  const BETA: PartyRef = { doctype: 'Customer', name: 'Beta Ltd' };
  const advanceBeta = (t: PendingTxn) => planAction(t, { type: 'customer_advance', party: BETA }, ctx());
  const ignore = () => planAction(txn(), { type: 'ignore' }, ctx());

  async function rejectedThenAccountant(docstatus: number) {
    const s = await setup();
    const a = advance(txn());
    s.erp.failNext('createDraft', new ErpValidationError('Value missing for Payment Entry: Cost Center', 417, ['Cost Center']));
    expect(await runPlan('t1', a, s.deps)).toMatchObject({ status: 'failed', retryable: false });
    expect((await s.repo.getOutbox(outboxIdFor('t1', a)))!.progress.attempting).toBeUndefined();
    // "complete this entry in ERPNext": the accountant enters it by hand (for Beta Ltd) with the same reference.
    s.erp.docs.push({ doctype: 'Payment Entry', name: 'PE-MANUAL', docstatus, body: { ...advanceBeta(txn()).steps[0].body } });
    return s;
  }

  it.each([0, 1])('Ignore keeps the accountant\'s document (docstatus %p)', async (ds) => {
    const { repo, erp, deps } = await rejectedThenAccountant(ds);
    expect(await runPlan('t1', ignore(), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-MANUAL']);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
  });

  it.each([0, 1])('plan B keeps the accountant\'s document and is not refused (docstatus %p)', async (ds) => {
    const { erp, deps } = await rejectedThenAccountant(ds);
    const r = await runPlan('t1', advanceBeta(txn()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-MANUAL' }] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-MANUAL']);
  });

  it('an auth rejection of the create also clears the marker', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    erp.failNext('createDraft', new ErpAuthError('ERPNext did not accept the credentials.', 401));
    expect(await runPlan('t1', a, deps)).toEqual({ status: 'needs_login' });
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.progress.attempting).toBeUndefined();
  });

  it('a lost reply (network) keeps the marker', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', a, deps);
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.progress.attempting).toBe(0);
  });

  it('a rejected createParty: the re-run creates a new party and does not reuse a namesake', async () => {
    const t = txn({ kind: 'ca_debit', direction: 'out' });
    const { erp, deps } = await setup(t);
    erp.seriesNaming = true;
    erp.parties.push({ doctype: 'Employee', name: 'HR-EMP-0003', displayName: 'Ravi Kumar' });
    erp.failNext('createParty', new ErpValidationError('Value missing for Employee: Gender', 417, ['Gender']));
    expect(await runPlan('t1', salaryNewEmployee(t), deps)).toMatchObject({ status: 'failed', retryable: false });
    expect(await runPlan('t1', salaryNewEmployee(t), deps)).toMatchObject({ status: 'created' });
    expect(erp.count('searchParties')).toBe(0);
    expect(erp.count('createParty')).toBe(2);
    expect(erp.parties.map((p) => p.name)).toEqual(['HR-EMP-0003', 'HR-EMP-0001']);
    expect(erp.docs[0].body.party).toBe('HR-EMP-0001');
  });
});

describe('runPlan: the created gate only answers the producing item (R43.3)', () => {
  function gateCreate(erp: FakeErp) {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = erp.createDraft.bind(erp);
    erp.createDraft = async (d, body) => { await gate; return orig(d, body); };
    return () => release();
  }

  it('B queued on the lock behind an in-flight A gets the readable refusal', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const a = advance(txn());
    const b = income(txn());
    const release = gateCreate(erp);
    const pA = runPlan('t1', a, deps);
    await new Promise((r) => setTimeout(r, 5));
    const pB = runPlan('t1', b, deps);
    release();
    expect(await pA).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    const rB = await pB;
    expect(rB).toMatchObject({ status: 'failed', retryable: false });
    if (rB.status === 'failed') expect(rB.error.message).toBe('This transaction was already processed (ACC-PAY-0001); use Undo in Activity to change it.');
    expect(erp.docs).toHaveLength(1);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    expect((await outbox()).map((o) => [o.id, o.status])).toEqual([[outboxIdFor('t1', a), 'done']]);
  });

  it('B pre-enqueued while A runs: A records its docs but stays superseded; B is refused, creates nothing', async () => {
    const { repo, erp, deps } = await setup();
    const a = advance(txn());
    const b = income(txn());
    const release = gateCreate(erp);
    const pA = runPlan('t1', a, deps);
    await new Promise((r) => setTimeout(r, 5));
    await repo.enqueue({ id: outboxIdFor('t1', b), txnId: 't1', plan: b, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    release();
    expect((await pA).status).toBe('created');
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    expect(await drain(repo, erp)).toEqual([outboxIdFor('t1', b)]);
    expect((await repo.getOutbox(outboxIdFor('t1', a)))!.status).toBe('superseded');
    expect((await repo.getOutbox(outboxIdFor('t1', b)))!.status).toBe('failed');
    expect(erp.docs).toHaveLength(1);
    expect(erp.docs[0].doctype).toBe('Payment Entry');
  });
});

describe('runPlan: a UTR shared with another txn (R43.4)', () => {
  it('cleanup does not delete a draft another txn has recorded', async () => {
    const { repo, erp, deps } = await setup();
    await runPlan('t1', advance(txn()), deps); // txn 1 owns ACC-PAY-0001 with UTR123
    const t2 = txn({ id: 't2', rawHash: 'h2', kind: 'ca_debit', direction: 'out' });
    await repo.upsertPending(t2);
    const pay = planAction(t2, { type: 'supplier_payment', party: { doctype: 'Supplier', name: 'Sup' } }, ctx());
    // txn 2's first attempt: the lookup misses and the create's outcome is unknown (marker kept).
    const orig = erp.findDraftsByUtr.bind(erp);
    let once = true;
    erp.findDraftsByUtr = async (ref) => { if (once) { once = false; erp.calls.push({ op: 'findDraftsByUtr', args: [ref] }); return []; } return orig(ref); };
    erp.failNext('createDraft', new ErpNetworkError('timeout'));
    await runPlan('t2', pay, deps);
    expect((await repo.getOutbox(outboxIdFor('t2', pay)))!.progress.attempting).toBe(0);
    // txn 2's decision is replaced by Ignore: the draft found by UTR123 belongs to txn 1.
    expect(await runPlan('t2', planAction(t2, { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001']);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
    expect((await repo.getOutbox(outboxIdFor('t2', pay)))!.progress).toEqual({ stepIndex: 0, created: [] });
  });
});

describe('Undo provenance with runPlan (R49 C1)', () => {
  it('A: a document adopted by a second txn (shared UTR) survives the second txn\'s Undo; the first txn is unaffected', async () => {
    // Both legs of an own-account transfer: the second leg books the very same Internal Transfer (KL1).
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const before = await repo.getPending('t1');
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001' }); // same UTR (the other leg)
    await repo.upsertPending(t2);
    const r = await runPlan('t2', transferLeg2(t2), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect((await repo.getPending('t2'))!.createdDocs[0].adopted).toBe(true);
    expect(await undoTxn('t2', deps)).toMatchObject({ status: 'undone', kept: [{ name: 'ACC-PAY-0001' }] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs).toHaveLength(1);
    expect(await repo.getPending('t1')).toEqual(before);
    expect((await repo.getPending('t2'))!.state).toBe('new');
  });

  it('B: a draft the accountant entered by hand and the app adopted is not deleted by Undo', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    await runPlan('t1', advance(txn()), deps);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, adopted: true }]);
    expect(await undoTxn('t1', deps)).toMatchObject({ status: 'undone', kept: [{ name: 'PE-HAND' }] });
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
    expect((await repo.getPending('t1'))!.state).toBe('new');
  });

  it('a draft created by this app is not flagged, and a recovered one (write-ahead marker) stays deletable', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advance(txn());
    erp.failNext('createDraft', new ErpNetworkError('Could not reach the ERPNext site.'), { afterEffect: true });
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'created' });
    const saved = (await repo.getPending('t1'))!;
    expect(saved.createdDocs[0].adopted).toBeUndefined();
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect(erp.docs).toHaveLength(0);
  });

  it('re-answering after Undo reopens the superseded item and creates a NEW document', async () => {
    const { repo, erp, outbox, deps } = await setup();
    const plan = advance(txn());
    await runPlan('t1', plan, deps);
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect((await outbox())[0].status).toBe('superseded');
    expect(await rawRunPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: false }); // the drainer never re-runs it
    expect(erp.docs).toHaveLength(0);
    const r = await runPlan('t1', plan, deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(erp.docs).toHaveLength(1);
    expect((await outbox()).map((o) => o.status)).toEqual(['done']);
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'created', createdDocs: [{ name: 'ACC-PAY-0002', docstatus: 0 }] });
  });
});

describe('a real UTR shared by several txns (KL1/KL2, R51)', () => {
  const SUP: PartyRef = { doctype: 'Supplier', name: 'Sup' };
  /** txn 1: money in from ACME (UTR123) booked as ACC-PAY-0001. */
  async function withTxn1() {
    const s = await setup();
    await runPlan('t1', advance(txn()), s.deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', kind: 'ca_debit', direction: 'out' }); // e.g. the reversal, same UTR
    await s.repo.upsertPending(t2);
    return { ...s, t2, t1Before: await s.repo.getPending('t1') };
  }

  it('second leg of an internal transfer adopts the first leg\'s Payment Entry', async () => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001' });
    await repo.upsertPending(t2);
    expect(await runPlan('t2', transferLeg2(t2), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(1);
    expect(erp.calls.filter((c) => c.op === 'getDraftSummary').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0001']]);
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }]);
  });

  it('a reversal with the same UTR (opposite direction, other party) creates its own document', async () => {
    const { repo, erp, deps, t2, t1Before } = await withTxn1();
    const r = await runPlan('t2', planAction(t2, { type: 'supplier_payment', party: SUP }, ctx()), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(erp.docs.map((d) => [d.name, d.body.payment_type, d.body.party])).toEqual([['ACC-PAY-0001', 'Receive', 'Acme Traders'], ['ACC-PAY-0002', 'Pay', 'Sup']]);
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]);
    expect(await repo.getPending('t1')).toEqual(t1Before);
  });

  it('an internal transfer with a different amount (fees) creates its own document', async () => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001', amountMinor: 1234000 });
    await repo.upsertPending(t2);
    const r = await runPlan('t2', transferLeg2(t2, { paid_amount: 12340, received_amount: 12340 }), deps);
    expect(r).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(erp.count('createDraft')).toBe(2);
    expect((await repo.getPending('t2'))!.createdDocs.map((d) => d.name)).toEqual(['ACC-PAY-0002']);
  });

  it.each([
    ['other accounts', { paid_to: 'HDFC CA - AL' }],
    ['another company', { company: 'Other Ltd' }],
  ])('an internal transfer between %s is not the same document', async (_l, over) => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001' });
    await repo.upsertPending(t2);
    expect(await runPlan('t2', transferLeg2(t2, over), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
  });

  it('another txn\'s document of a different doctype is skipped, not a blocking error', async () => {
    const s = await setup();
    await runPlan('t1', income(txn()), s.deps); // txn 1: Journal Entry ACC-JV-0001 with cheque_no UTR123
    const t2 = txn({ id: 't2', rawHash: 'h2' });
    await s.repo.upsertPending(t2);
    expect(await runPlan('t2', advance(t2), s.deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
  });

  it('a document of a different doctype that NO txn lists still blocks (today\'s behaviour)', async () => {
    const { erp, deps } = await setup();
    erp.docs.push({ doctype: 'Journal Entry', name: 'JV-HAND', docstatus: 0, body: { cheque_no: 'UTR123' } });
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toMatch(/An entry JV-HAND \(Journal Entry\) already exists/);
  });

  it('multiple hits (txn 1\'s first, own lost reply second): the retry picks its own draft and never lists txn 1\'s', async () => {
    const { repo, erp, deps, t2, t1Before } = await withTxn1();
    const pay = planAction(t2, { type: 'supplier_payment', party: SUP }, ctx());
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t2', pay, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001', 'ACC-PAY-0002']);
    expect(await runPlan('t2', pay, deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(erp.count('createDraft')).toBe(2);
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]); // ours: deletable by Undo
    expect(await repo.getPending('t1')).toEqual(t1Before);
    expect(await undoTxn('t2', deps)).toEqual({ status: 'undone' });
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001']);
  });

  it('the other txn\'s document gone meanwhile (404 on read): creates its own', async () => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001' });
    await repo.upsertPending(t2);
    erp.failNext('getDraftSummary', new ErpValidationError('not found', 404));
    expect(await runPlan('t2', transferLeg2(t2), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
  });

  it('a network error reading the candidate is retried later, nothing created', async () => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001' });
    await repo.upsertPending(t2);
    erp.failNext('getDraftSummary', new ErpNetworkError('offline'));
    expect(await runPlan('t2', transferLeg2(t2), deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(erp.count('createDraft')).toBe(1);
  });

  // ----- R51: cleanup of replaced decisions follows the Undo rule -----

  it('replacing a decision after an adoption keeps the adopted (hand-made) document', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    // Two documents: step 0 adopts PE-HAND, step 1's create fails on the network (nothing reached the server).
    const plan: ActionPlan = { steps: [advance(txn()).steps[0], income(txn({ utr: 'UTR999' })).steps[0]], summary: [], needsInrAmount: false };
    erp.failNext('createDraft', new ErpNetworkError('timeout'));
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'failed', retryable: true });
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, adopted: true }]);
    expect((await repo.getOutbox(outboxIdFor('t1', plan)))!.progress.created).toEqual([{ doctype: 'Payment Entry', name: 'PE-HAND', adopted: true }]);
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
    const saved = (await repo.getPending('t1'))!;
    expect(saved.state).toBe('ignored');
    expect(saved.createdDocs).toEqual([]); // detached
  });

  it('a retry after an adoption keeps the adopted flag, so Undo still never deletes the hand-made document', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    const plan: ActionPlan = { steps: [advance(txn()).steps[0], income(txn({ utr: 'UTR999' })).steps[0]], summary: [], needsInrAmount: false };
    erp.failNext('createDraft', new ErpNetworkError('timeout'));
    await runPlan('t1', plan, deps);
    expect(await runPlan('t1', plan, deps)).toMatchObject({ status: 'created' });
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([
      { doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, adopted: true },
      { doctype: 'Journal Entry', name: 'ACC-JV-0001', docstatus: 0 },
    ]);
    expect(await undoTxn('t1', deps)).toMatchObject({ status: 'undone', kept: [{ name: 'PE-HAND' }] });
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
  });

  it('the adopted flag on the outbox progress alone protects the document (txn record lost)', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    const plan: ActionPlan = { steps: [advance(txn()).steps[0], income(txn({ utr: 'UTR999' })).steps[0]], summary: [], needsInrAmount: false };
    erp.failNext('createDraft', new ErpNetworkError('timeout'));
    await runPlan('t1', plan, deps);
    await repo.upsertPending({ ...(await repo.getPending('t1'))!, createdDocs: [] }); // crash before the txn write
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
  });

  it('a recorded document that another txn lists is detached, not deleted, when the decision is replaced', async () => {
    const t1 = txn({ kind: 'ca_debit', direction: 'out' });
    const { repo, erp, deps } = await setup(t1);
    await runPlan('t1', transferOut(t1), deps);
    const t1Before = await repo.getPending('t1');
    // txn 2 recorded txn 1's document without the adopted flag (e.g. written by an older build).
    const t2 = txn({ id: 't2', rawHash: 'h2', accountLast4: '9001', createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }] });
    await repo.upsertPending(t2);
    expect(await runPlan('t2', planAction(t2, { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001']);
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([]);
    expect(await repo.getPending('t1')).toEqual(t1Before);
  });

  it('a submitted adopted document does not block a replaced decision (it is only detached)', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body } });
    const plan: ActionPlan = { steps: [advance(txn()).steps[0], income(txn({ utr: 'UTR999' })).steps[0]], summary: [], needsInrAmount: false };
    erp.failNext('createDraft', new ErpNetworkError('timeout'));
    await runPlan('t1', plan, deps);
    erp.docs[0].docstatus = 1;
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.docs.map((d) => [d.name, d.docstatus])).toEqual([['PE-HAND', 1]]);
  });

  it('own lost-reply draft is still cleaned when another txn\'s document with the same UTR comes first', async () => {
    const { repo, erp, deps, t2, t1Before } = await withTxn1();
    const pay = planAction(t2, { type: 'supplier_payment', party: SUP }, ctx());
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t2', pay, deps);
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001', 'ACC-PAY-0002']);
    expect(await runPlan('t2', planAction(t2, { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0002']]);
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001']);
    expect(await repo.getPending('t1')).toEqual(t1Before);
  });
});

describe('an unlisted reference hit is adopted only when provably ours or the planned document (T20A I1)', () => {
  const SUP: PartyRef = { doctype: 'Supplier', name: 'Sup' };
  const t2 = txn({ id: 't2', rawHash: 'h2', kind: 'ca_debit', direction: 'out' }); // the reversal, same UTR
  const reversal = () => planAction(t2, { type: 'supplier_payment', party: SUP }, ctx());

  /** txn 1 (the receipt) creates ACC-PAY-0001 but the reply is lost: only its write-ahead marker remains. */
  async function txn1LostReply() {
    const s = await setup();
    s.erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t1', advance(txn()), s.deps)).toMatchObject({ status: 'failed', retryable: true });
    const item = (await s.repo.getOutbox(outboxIdFor('t1', advance(txn()))))!;
    expect(item.progress).toEqual({ stepIndex: 0, created: [], attempting: 0 });
    expect((await s.repo.getPending('t1'))!.createdDocs).toEqual([]);
    await s.repo.upsertPending(t2);
    return s;
  }

  it('txn 1 lost reply, txn 2 reversal answered, txn 1 retries: no duplicate receipt, the reversal books its own', async () => {
    const { repo, erp, deps } = await txn1LostReply();
    expect(await runPlan('t2', reversal(), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]); // never ACC-PAY-0001
    expect(await rawRunPlan('t1', advance(txn()), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(2);
    expect(erp.docs.map((d) => [d.name, d.body.payment_type])).toEqual([['ACC-PAY-0001', 'Receive'], ['ACC-PAY-0002', 'Pay']]);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]); // ours
    expect(await undoTxn('t1', deps)).toEqual({ status: 'undone' });
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0002']);
  });

  it('cleanup of a replaced decision never deletes another txn\'s unrecorded draft, but does delete its own', async () => {
    const { repo, erp, deps } = await txn1LostReply();
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t2', reversal(), deps)).toMatchObject({ status: 'failed', retryable: true }); // txn 2 lost reply too
    expect(erp.docs.map((d) => d.name)).toEqual(['ACC-PAY-0001', 'ACC-PAY-0002']);
    expect(await runPlan('t2', planAction(t2, { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0002']]);
    expect(await rawRunPlan('t1', advance(txn()), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(2);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
  });

  it('crash between txn 1\'s progress write and its txn write: txn 2 does not adopt the document, even a matching one', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advance(txn());
    await runPlan('t1', plan, deps);
    // Model the crash: the step's progress was saved, the final txn write and the done write were not.
    await repo.upsertPending({ ...(await repo.getPending('t1'))!, state: 'new', createdDocs: [] });
    await repo.markOutbox(outboxIdFor('t1', plan), { status: 'pending' });
    const t2same = txn({ id: 't2', rawHash: 'h2' }); // same UTR, same details as txn 1's document
    await repo.upsertPending(t2same);
    expect(await runPlan('t2', advance(t2same), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect((await repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0002', docstatus: 0 }]);
    expect(await rawRunPlan('t1', plan, deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(2);
  });

  it('crash variant with a reversal: txn 2 books its own, txn 1 finishes with its recorded document', async () => {
    const { repo, erp, deps } = await setup();
    const plan = advance(txn());
    await runPlan('t1', plan, deps);
    await repo.upsertPending({ ...(await repo.getPending('t1'))!, state: 'new', createdDocs: [] });
    await repo.markOutbox(outboxIdFor('t1', plan), { status: 'pending' });
    await repo.upsertPending(t2);
    expect(await runPlan('t2', reversal(), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0002' }] });
    expect(await rawRunPlan('t1', plan, deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect(erp.count('createDraft')).toBe(2);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
  });

  it('an accountant\'s hand-made draft with the planned details is still adopted', async () => {
    const { repo, erp, deps } = await setup();
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body, remarks: 'by hand' } });
    expect(await runPlan('t1', advance(txn()), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'PE-HAND' }] });
    expect(erp.count('createDraft')).toBe(0);
    expect(erp.calls.filter((c) => c.op === 'getDraftSummary').map((c) => c.args)).toEqual([['Payment Entry', 'PE-HAND']]);
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, adopted: true }]);
  });

  it.each([
    ['another amount', { paid_amount: 999, received_amount: 999 }],
    ['another party', { party: 'Someone Else' }],
    ['another payment type', { payment_type: 'Pay', party_type: 'Supplier' }],
    ['another bank account', { paid_to: 'HDFC CA - AL' }],
    ['no details at all', null],
  ])('a hand-made draft nobody lists with %s blocks (no second document): the user resolves it', async (_l, over) => {
    const { repo, erp, deps } = await setup();
    const body = over ? { ...advance(txn()).steps[0].body, ...over } : { reference_no: 'UTR123' };
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body });
    const r = await runPlan('t1', advance(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toMatch(/An entry PE-HAND \(Payment Entry\) already exists for this reference/);
    expect(erp.count('createDraft')).toBe(0);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
    expect((await repo.getPending('t1'))!).toMatchObject({ state: 'new', createdDocs: [] });
  });

  it('a non-matching hand-made draft is skipped when a later hit is this step\'s own lost reply (P3, retry)', async () => {
    const { repo, erp, deps } = await setup();
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', advance(txn()), deps);
    erp.docs.unshift({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body, party: 'Someone Else' } });
    expect(await rawRunPlan('t1', advance(txn()), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001' }] });
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }]);
  });

  it('cleanup deletes the own lost-reply draft, never a non-matching hand-made one that comes first (P3)', async () => {
    const { repo, erp, deps } = await setup();
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    await runPlan('t1', advance(txn()), deps);
    erp.docs.unshift({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body, party: 'Someone Else' } });
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.calls.filter((c) => c.op === 'deleteDraft').map((c) => c.args)).toEqual([['Payment Entry', 'ACC-PAY-0001']]);
    expect(erp.docs.map((d) => d.name)).toEqual(['PE-HAND']);
    expect((await repo.getPending('t1'))!.state).toBe('ignored');
  });

  it('cleanup leaves an unrecorded hit that is not the planned document alone (nothing to clean)', async () => {
    const { erp, deps } = await setup();
    erp.failNext('createDraft', new ErpNetworkError('timeout')); // nothing reached the server
    await runPlan('t1', advance(txn()), deps);
    erp.docs.push({ doctype: 'Payment Entry', name: 'PE-HAND', docstatus: 0, body: { ...advance(txn()).steps[0].body, paid_amount: 1 } });
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.count('deleteDraft')).toBe(0);
  });

  it('cleanup recognises its own lost-reply draft of a renamed new party (series naming)', async () => {
    const { erp, deps } = await setup();
    erp.seriesNaming = true;
    erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t1', advanceNewParty(txn()), deps)).toMatchObject({ status: 'failed', retryable: true });
    expect(erp.docs.map((d) => [d.name, d.body.party])).toEqual([['ACC-PAY-0001', 'CUST-0001']]);
    expect(await runPlan('t1', planAction(txn(), { type: 'ignore' }, ctx()), deps)).toEqual({ status: 'created', docs: [] });
    expect(erp.docs).toEqual([]);
  });
});

describe('Journal Entries are compared row by row: a reversal is never adopted (T20A round 2)', () => {
  const tOut = txn({ kind: 'ca_debit', direction: 'out' });
  const tIn = txn({ id: 't2', rawHash: 'h2', kind: 'ca_credit', direction: 'in' });
  const rows = (d: { body: Record<string, unknown> }) =>
    (d.body.accounts as Record<string, unknown>[]).map((r) => [r.account, r.debit_in_account_currency ?? 0, r.credit_in_account_currency ?? 0]);

  async function lostReplyThenReversal(first: ActionPlan, second: ActionPlan) {
    const s = await setup(tOut);
    s.erp.failNext('createDraft', new ErpNetworkError('timeout'), { afterEffect: true });
    expect(await runPlan('t1', first, s.deps)).toMatchObject({ status: 'failed', retryable: true });
    await s.repo.upsertPending(tIn);
    expect(await runPlan('t2', second, s.deps)).toEqual({ status: 'created', docs: [{ doctype: 'Journal Entry', name: 'ACC-JV-0002' }] });
    expect(await rawRunPlan('t1', first, s.deps)).toEqual({ status: 'created', docs: [{ doctype: 'Journal Entry', name: 'ACC-JV-0001' }] });
    expect(s.erp.count('createDraft')).toBe(2);
    expect((await s.repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Journal Entry', name: 'ACC-JV-0001', docstatus: 0 }]);
    expect((await s.repo.getPending('t2'))!.createdDocs).toEqual([{ doctype: 'Journal Entry', name: 'ACC-JV-0002', docstatus: 0 }]);
    return s;
  }

  it('P1: personal withdrawal (lost reply) and personal deposit with the same UTR: one withdrawal, one deposit', async () => {
    const { erp } = await lostReplyThenReversal(planAction(tOut, { type: 'personal' }, ctx()), planAction(tIn, { type: 'personal' }, ctx()));
    expect(rows(erp.docs[0])).toEqual([['Drawings - AL', 12345, 0], ['IDFC CA - AL', 0, 12345]]);
    expect(rows(erp.docs[1])).toEqual([['IDFC CA - AL', 12345, 0], ['Drawings - AL', 0, 12345]]);
  });

  it('expense (lost reply) and other income on the same account: the income books its own', async () => {
    const { erp } = await lostReplyThenReversal(
      planAction(tOut, { type: 'expense', expenseAccount: 'Misc - AL' }, ctx()),
      planAction(tIn, { type: 'other_income', incomeAccount: 'Misc - AL' }, ctx()),
    );
    expect(rows(erp.docs[0])).toEqual([['Misc - AL', 12345, 0], ['IDFC CA - AL', 0, 12345]]);
    expect(rows(erp.docs[1])).toEqual([['IDFC CA - AL', 12345, 0], ['Misc - AL', 0, 12345]]);
  });

  it('a hand-made Journal Entry with the planned rows (any order) is adopted', async () => {
    const { repo, erp, deps } = await setup();
    const body = income(txn()).steps[0].body;
    erp.docs.push({ doctype: 'Journal Entry', name: 'JV-HAND', docstatus: 0, body: { ...body, accounts: [...(body.accounts as unknown[])].reverse() } });
    expect(await runPlan('t1', income(txn()), deps)).toEqual({ status: 'created', docs: [{ doctype: 'Journal Entry', name: 'JV-HAND' }] });
    expect((await repo.getPending('t1'))!.createdDocs).toEqual([{ doctype: 'Journal Entry', name: 'JV-HAND', docstatus: 0, adopted: true }]);
  });

  it.each([
    ['swapped debit and credit', (r: Record<string, unknown>[]) => r.map((x) => ({ account: x.account, debit_in_account_currency: x.credit_in_account_currency, credit_in_account_currency: x.debit_in_account_currency }))],
    ['another amount', (r: Record<string, unknown>[]) => r.map((x) => ({ ...x, ...(x.debit_in_account_currency ? { debit_in_account_currency: 1 } : { credit_in_account_currency: 1 }) }))],
    ['another account', (r: Record<string, unknown>[]) => r.map((x, k) => (k === 1 ? { ...x, account: 'Other Income - AL' } : x))],
  ])('a hand-made Journal Entry with %s blocks', async (_l, change) => {
    const { erp, deps } = await setup();
    const body = income(txn()).steps[0].body;
    erp.docs.push({ doctype: 'Journal Entry', name: 'JV-HAND', docstatus: 0, body: { ...body, accounts: change(body.accounts as Record<string, unknown>[]) } });
    const r = await runPlan('t1', income(txn()), deps);
    expect(r).toMatchObject({ status: 'failed', retryable: false });
    if (r.status === 'failed') expect(r.error.message).toMatch(/An entry JV-HAND \(Journal Entry\) already exists/);
    expect(erp.count('createDraft')).toBe(0);
  });
});
