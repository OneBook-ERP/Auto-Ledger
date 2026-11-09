// Outbox runner: executes an ActionPlan against ERPNext step by step. ERPNext REST has no multi-document
// transactions, so safety comes from (1) an idempotency lookup by reference before every document create,
// (2) per-step progress persisted in the outbox, (3) compensation (deleting this run's drafts) when a step is
// rejected for good, and (4) an in-process lock per txn. Spec section 13; plan Review Focus 3, 4, 5.
//
// The runner owns the outbox item for (txnId, plan): its id is outboxIdFor(txnId, plan). A caller may
// enqueue it first under that id (for example the pipeline); otherwise runPlan enqueues it and supersedes
// the txn's other pending items. Progress and attempts are read back with repo.getOutbox.
// It never submits a document and never logs.
import type { ActionPlan, OutboxOp, PartyRef, PendingTxn, PlanStep } from '../core/types';
import type { Repo } from '../data/repo';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
import { NotDraftError, toMinor, type UtrHit } from '../erp/docs';
import type { ErpOps } from './erpOps';

export type { ErpOps } from './erpOps';

export type RunResult =
  | { status: 'created'; docs: { doctype: string; name: string }[] }
  | { status: 'failed'; error: ErpValidationError | ErpNetworkError; retryable: boolean }
  | { status: 'needs_login' };

type Progress = OutboxOp['progress'];
type DocRef = { doctype: string; name: string };
type CreatedDoc = PendingTxn['createdDocs'][number];

const REF_FIELD: Record<string, string> = { 'Payment Entry': 'reference_no', 'Journal Entry': 'cheque_no' };
const PARTY_TYPES = new Set<string>(['Customer', 'Supplier', 'Employee']);
const NAME_FIELD: Record<string, string> = { Customer: 'customer_name', Supplier: 'supplier_name', Employee: 'employee_name' };

/** The UTR/reference the planner wrote: `reference_no` (Payment Entry) or `cheque_no` (Journal Entry). */
export function referenceOf(step: PlanStep): string | null {
  if (step.kind !== 'create_doc') return null;
  const field = REF_FIELD[step.doctype];
  if (!field) return null;
  const v = step.body[field];
  return typeof v === 'string' && v.trim() ? v : null;
}

// cyrb53: small non-crypto hash, only to give each distinct plan for a txn its own outbox id.
function cyrb53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Deterministic outbox id for running `plan` on `txnId`. */
export function outboxIdFor(txnId: string, plan: ActionPlan): string {
  return `${txnId}#${cyrb53(JSON.stringify(plan.steps))}`;
}

// ---------- per-txn lock ----------

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

// ---------- outbox bookkeeping ----------

type Known = { progress: Progress; attempts: number };

async function writeOp(repo: Repo, id: string, k: Known, status?: OutboxOp['status']): Promise<void> {
  await repo.markOutbox(id, { progress: k.progress, attempts: k.attempts, ...(status ? { status } : {}) });
}

async function writeTxn(repo: Repo, txnId: string, fallback: PendingTxn, patch: Pick<PendingTxn, 'state' | 'createdDocs' | 'error'>) {
  // Re-read so a concurrent field update (e.g. enrichment) is not overwritten (R32: replace by id).
  const cur = (await repo.getPending(txnId)) ?? fallback;
  await repo.upsertPending({ ...cur, ...patch });
}

// ---------- plan checks ----------

function checkPlan(plan: ActionPlan): string | null {
  if (plan.needsInrAmount) return 'Enter the INR amount before creating this entry.';
  const refs = new Set<string>();
  for (const s of plan.steps) {
    const ds = s.body.docstatus;
    if (ds !== undefined && ds !== 0) {
      return 'AutoLedger only creates drafts. This plan asked ERPNext to submit a document, so nothing was sent.';
    }
    if (s.kind === 'create_party') {
      if (!PARTY_TYPES.has(s.doctype)) return `AutoLedger cannot create a ${s.doctype}.`;
    } else if (s.kind === 'create_doc') {
      if (!REF_FIELD[s.doctype]) return `AutoLedger cannot create a ${s.doctype}.`;
      const ref = referenceOf(s);
      if (!ref) return `The ${s.doctype} has no transaction reference, so it cannot be created safely.`;
      if (refs.has(ref)) return 'Two entries in this plan share one reference, so it cannot be created safely.';
      refs.add(ref);
    } else {
      return 'This plan contains an unknown step.';
    }
  }
  return null;
}

/** The party name the later document steps refer to (the planner writes the chosen PartyRef name there). */
function referencedPartyName(plan: ActionPlan, i: number): string | null {
  const dt = plan.steps[i].doctype;
  for (const s of plan.steps.slice(i + 1)) {
    if (s.kind !== 'create_doc') continue;
    if (s.body.party_type === dt && typeof s.body.party === 'string') return s.body.party;
    const rows = Array.isArray(s.body.accounts) ? (s.body.accounts as Record<string, unknown>[]) : [];
    const row = rows.find((r) => r && r.party_type === dt && typeof r.party === 'string');
    if (row) return row.party as string;
  }
  return null;
}

/**
 * The display name ERPNext will store for the new party: customer_name / supplier_name, or for an Employee
 * first + middle + last (ERPNext overwrites employee_name with that, so a caller-supplied one is ignored).
 */
function displayNameOf(step: PlanStep): string | null {
  const f = step.body;
  if (step.doctype === 'Employee') {
    const full = [f.first_name, f.middle_name, f.last_name]
      .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
      .map((x) => x.trim())
      .join(' ');
    return full || null;
  }
  const direct = f[NAME_FIELD[step.doctype]];
  return typeof direct === 'string' && direct.trim() ? direct.trim() : null;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Points document party fields at the names ERPNext actually assigned to parties created in this plan. */
function applyRenames(body: Record<string, unknown>, renames: Map<string, string>): Record<string, unknown> {
  if (!renames.size) return { ...body };
  const sub = (row: Record<string, unknown>) => {
    const to = typeof row.party === 'string' ? renames.get(`${row.party_type}\u0000${row.party}`) : undefined;
    return to ? { ...row, party: to } : row;
  };
  const out = sub({ ...body });
  if (Array.isArray(out.accounts)) out.accounts = (out.accounts as Record<string, unknown>[]).map((r) => (r && typeof r === 'object' ? sub(r) : r));
  return out;
}

// ---------- readable errors ----------

function describeFailure(e: ErpValidationError, step: PlanStep): string {
  const what = step.kind === 'create_party' ? `the new ${step.doctype}` : `the ${step.doctype}`;
  const parts = [`Could not create ${what}.`];
  if (e.missingFields?.length) {
    parts.push(`ERPNext needs these fields: ${e.missingFields.join(', ')}. Fill them in ERPNext, or complete this entry in ERPNext.`);
  }
  if (e.closedPeriod) {
    parts.push('The accounting period is closed for this date. Ask your accountant to reopen it, or complete this entry in ERPNext.');
  }
  if (!e.missingFields?.length && !e.closedPeriod) parts.push(e.message);
  return parts.join(' ');
}

const ERP_ERROR = (e: unknown): e is Error =>
  e instanceof ErpAuthError || e instanceof ErpValidationError || e instanceof ErpNetworkError || (e instanceof Error && e.name === 'NotDraftError');

// ---------- replaced decisions: orphan drafts ----------

const docKey = (d: DocRef) => `${d.doctype}:${d.name}`;
const submittedError = (name: string) => new ErpValidationError(`${name} was already submitted in ERPNext; cancel it there first.`, 0);
const replacedError = () => new ErpValidationError('This action was replaced by a newer decision.', 0);

/** Progress of a cleaned-up item: party steps are kept (master data is never deleted), document steps forgotten. */
function withoutDocs(op: OutboxOp): Progress {
  const k = op.plan.steps.findIndex((s) => s.kind === 'create_doc');
  const upto = k < 0 ? op.progress.stepIndex : Math.min(op.progress.stepIndex, k);
  const att = op.progress.attempting;
  return { stepIndex: upto, created: op.progress.created.slice(0, upto), ...(att !== undefined && (k < 0 || att < k) ? { attempting: att } : {}) };
}

type Orphans = { items: OutboxOp[]; docs: DocRef[] };

/**
 * What the txns other than `txnId` claim. `docs`: `${doctype}:${name}` of every document such a txn has recorded,
 * on the txn or in the progress of one of its open outbox items (a crash between a step's progress write and the
 * final txn write leaves the document only there). `attempting`: `${doctype}\u0000${reference}` of every document
 * step such a txn has STARTED on an open item (pending or failed) without recording its result (write-ahead
 * marker, lost reply): an unlisted draft with that reference may be that txn's. Two queries; read afresh for
 * every step that has a hit (another txn may have advanced in between).
 */
type Claims = { docs: Set<string>; attempting: Set<string> };
const claimKey = (doctype: string, ref: string) => `${doctype}\u0000${ref}`;

async function claimsOfOtherTxns(repo: Repo, txnId: string): Promise<Claims> {
  const docs = new Set<string>();
  const attempting = new Set<string>();
  for (const t of await repo.listPending()) if (t.id !== txnId) for (const d of t.createdDocs) docs.add(docKey(d));
  for (const o of await repo.listOpenOutbox()) {
    if (o.txnId === txnId) continue;
    for (const c of o.progress.created.slice(0, o.progress.stepIndex)) if (c) docs.add(docKey(c));
    const att = o.progress.attempting;
    if (att === undefined || att < o.progress.stepIndex) continue;
    const s = o.plan.steps[att];
    const ref = s ? referenceOf(s) : null;
    if (s && ref) attempting.add(claimKey(s.doctype, ref));
  }
  return { docs, attempting };
}

/** Party renames of item `o`: the names ERPNext assigned to the parties its finished steps created. */
function renamesOf(o: OutboxOp): Map<string, string> {
  const renames = new Map<string, string>();
  o.plan.steps.forEach((s, j) => {
    const c = j < o.progress.stepIndex ? o.progress.created[j] : undefined;
    if (s.kind !== 'create_party' || !c) return;
    const refName = referencedPartyName(o.plan, j);
    if (refName && c.name !== refName) renames.set(`${s.doctype}\u0000${refName}`, c.name);
  });
  return renames;
}

/**
 * Read-only. Drafts left on the server by this txn's replaced decisions (other unfinished outbox items whose
 * document create was attempted, and documents recorded on the txn that the current item did not make).
 * Same rule as Undo (splitRemovable, R51): only a document this app created for this txn is deleted. One it
 * adopted by reference (an accountant's draft, the shared leg of a transfer) or that another txn lists is
 * detached: dropped from this txn's record and left in ERPNext.
 * Throws the "already submitted" ErpValidationError when a document to delete is no longer a draft.
 */
async function findOrphans(repo: Repo, erp: ErpOps, others: OutboxOp[], txn: PendingTxn, keep: Set<string>): Promise<Orphans> {
  const docs: DocRef[] = [];
  const seen = new Set<string>(keep);
  const items: OutboxOp[] = [];
  // A real UTR can be shared with another txn (reversal/refund, both legs of an own-account transfer).
  // A document that another txn has recorded is that txn's, never this txn's orphan.
  let foreign: Claims | null = null;
  const adopted = new Set(txn.createdDocs.filter((d) => d.adopted).map(docKey));
  const removable = async (d: DocRef) => {
    if (adopted.has(docKey(d))) return false;
    foreign ??= await claimsOfOtherTxns(repo, txn.id);
    return !foreign.docs.has(docKey(d));
  };
  const fresh = () => {
    foreign = null; // re-read the other txns' claims for every step that looks at hits
  };
  for (const o of others) {
    const steps = o.plan.steps
      .map((s, j) => ({ s, j }))
      .filter(({ s, j }) => s.kind === 'create_doc' && (j < o.progress.stepIndex || j === o.progress.attempting));
    if (!steps.length) continue;
    items.push(o);
    for (const { s, j } of steps) {
      // Only a document of that item's own doctype is its orphan; anything else is not ours to touch.
      fresh();
      const hits = (await erp.findDraftsByUtr(referenceOf(s) as string)).filter((h) => h.doctype === s.doctype && !seen.has(docKey(h)));
      const rec = j < o.progress.stepIndex ? o.progress.created[j] : undefined;
      let hit: (typeof hits)[number] | undefined;
      if (rec) {
        // A finished step names its document; if that one is gone, nothing else with the reference is its orphan.
        if (rec.adopted) adopted.add(docKey(rec));
        hit = hits.find((h) => h.name === rec.name);
      } else {
        // Started but unrecorded (lost reply): the first hit that no other txn lists, this txn did not adopt,
        // and that IS the document this item planned (samePlanned, party renames applied). A hit that does not
        // match (entered by hand, or another txn's) is never deleted; if none matches there is nothing to clean.
        const body = applyRenames(s.body, renamesOf(o));
        for (const h of hits) {
          if ((await removable(h)) && (await samePlanned(erp, h, s.doctype, body))) {
            hit = h;
            break;
          }
        }
      }
      if (!hit) continue;
      seen.add(docKey(hit));
      if (!(await removable(hit))) continue; // detached, never deleted
      if (hit.docstatus !== 0) throw submittedError(hit.name);
      docs.push({ doctype: hit.doctype, name: hit.name });
    }
  }
  fresh();
  const recorded: CreatedDoc[] = [];
  for (const d of txn.createdDocs) if (!seen.has(docKey(d)) && (await removable(d))) recorded.push(d); // others: detached
  if (recorded.length) {
    const st = await erp.getDocStatuses(recorded.map(({ doctype, name }) => ({ doctype, name })));
    for (const d of recorded) {
      const ds = st[docKey(d)];
      if (ds === undefined || ds === 2) continue; // gone or cancelled
      if (ds !== 0) throw submittedError(d.name);
      seen.add(docKey(d));
      docs.push({ doctype: d.doctype, name: d.name });
    }
  }
  return { items, docs };
}

async function removeOrphans(repo: Repo, erp: ErpOps, o: Orphans): Promise<void> {
  for (const d of o.docs) {
    try {
      await erp.deleteDraft(d.doctype, d.name);
    } catch (e) {
      if (e instanceof NotDraftError) {
        if (e.docstatus === 2) continue;
        throw submittedError(d.name);
      }
      if (e instanceof ErpValidationError && e.status === 404) continue; // already gone
      throw e;
    }
  }
  for (const it of o.items) await repo.markOutbox(it.id, { progress: withoutDocs(it) });
}

// ---------- shared real UTR (KL1) ----------

/**
 * True when `hit` (a Payment Entry another txn recorded) is exactly the Internal Transfer that `body` plans:
 * both legs of an own-account transfer carry the bank's UTR and the planner books ONE Payment Entry for them
 * (same paid_from, paid_to, amount and company, no party). A document that is gone is not the same.
 */
async function sameTransfer(erp: ErpOps, hit: UtrHit, body: Record<string, unknown>): Promise<boolean> {
  if (hit.doctype !== 'Payment Entry' || body.payment_type !== 'Internal Transfer') return false;
  if (typeof body.paid_amount !== 'number' || !Number.isFinite(body.paid_amount)) return false;
  let s;
  try {
    s = await erp.getDraftSummary(hit.doctype, hit.name);
  } catch (e) {
    if (e instanceof ErpValidationError && e.status === 404) return false;
    throw e;
  }
  return (
    s.paymentType === 'Internal Transfer'
    && s.paidFrom !== null && s.paidFrom === body.paid_from
    && s.paidTo !== null && s.paidTo === body.paid_to
    && s.paidAmountMinor !== null && s.paidAmountMinor === toMinor(body.paid_amount)
    && (s.company === null || typeof body.company !== 'string' || s.company === body.company)
    && s.party === null
  );
}

/**
 * True when `hit` is the document `body` plans (read with getDraftSummary; a document that is gone is not):
 *  - Payment Entry: same payment type and amount (minor units), the same paid_from / paid_to and party (and
 *    party type) when the plan names them, no party when it names none;
 *  - Journal Entry: the same account rows: for every account the same debit and credit (minor units, row order
 *    ignored; a reversal swaps them), and the planned party on that account's row when one is planned;
 *  - and the same company when both name one.
 */
async function samePlanned(erp: ErpOps, hit: UtrHit, doctype: string, body: Record<string, unknown>): Promise<boolean> {
  if (hit.doctype !== doctype) return false;
  let s;
  try {
    s = await erp.getDraftSummary(hit.doctype, hit.name);
  } catch (e) {
    if (e instanceof ErpValidationError && e.status === 404) return false;
    throw e;
  }
  if (typeof body.company === 'string' && s.company !== null && s.company !== body.company) return false;
  if (doctype === 'Payment Entry') {
    if (typeof body.paid_amount !== 'number' || !Number.isFinite(body.paid_amount)) return false;
    if (s.paymentType === null || s.paymentType !== body.payment_type) return false;
    if (s.paidAmountMinor === null || s.paidAmountMinor !== toMinor(body.paid_amount)) return false;
    if (typeof body.paid_from === 'string' && s.paidFrom !== body.paid_from) return false;
    if (typeof body.paid_to === 'string' && s.paidTo !== body.paid_to) return false;
    if (typeof body.party === 'string' && (s.party !== body.party || (typeof body.party_type === 'string' && s.partyType !== body.party_type))) return false;
    if (typeof body.party !== 'string' && s.party !== null) return false;
    return true;
  }
  const planned = Array.isArray(body.accounts) ? (body.accounts as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? toMinor(v) : 0);
  const totals = (rows: { account: string | null; debit: number; credit: number }[]) => {
    const m = new Map<string, { debit: number; credit: number }>();
    for (const r of rows) {
      if (!r.debit && !r.credit) continue;
      const k = r.account ?? '';
      const t = m.get(k) ?? { debit: 0, credit: 0 };
      m.set(k, { debit: t.debit + r.debit, credit: t.credit + r.credit });
    }
    return m;
  };
  const want = totals(planned.map((r) => ({ account: typeof r.account === 'string' ? r.account : null, debit: num(r.debit_in_account_currency), credit: num(r.credit_in_account_currency) })));
  const got = totals(s.accounts.map((r) => ({ account: r.account, debit: r.debitMinor, credit: r.creditMinor })));
  if (!want.size || want.size !== got.size) return false;
  for (const [k, w] of want) {
    const g = got.get(k);
    if (!g || g.debit !== w.debit || g.credit !== w.credit) return false;
  }
  for (const r of planned) {
    if (typeof r.party !== 'string') continue;
    if (!s.accounts.some((a) => a.account === r.account && a.party === r.party && (typeof r.party_type !== 'string' || a.partyType === r.party_type))) return false;
  }
  return true;
}

// ---------- runner ----------

export type RunOptions = {
  /** true only on the UI path (the user's decision): may enqueue or re-open the item. The drainer omits it. */
  userAction?: boolean;
};

export function runPlan(txnId: string, plan: ActionPlan, deps: { repo: Repo; erp: ErpOps }, opts: RunOptions = {}): Promise<RunResult> {
  return withLock(txnId, () => run(txnId, plan, deps, opts.userAction === true));
}

export const PERMISSION_DENIED_MESSAGE =
  'Your ERPNext user is not allowed to create this document; ask your administrator for access, then try again';

/**
 * Drainer only: takes outbox item `itemId` of `txnId` out of the queue after repeated permission refusals.
 * Runs under the same per-txn lock as runPlan and re-reads both rows, so it parks ONLY if the item is still
 * 'pending' and the txn is still 'new' (status 'failed', txn error = PERMISSION_DENIED_MESSAGE, nothing else
 * changed). Otherwise, e.g. the user made a newer decision meanwhile, it changes nothing: 'skipped'.
 */
export function parkForPermission(txnId: string, itemId: string, deps: { repo: Repo }): Promise<'parked' | 'skipped'> {
  return withLock(txnId, async () => {
    const { repo } = deps;
    const item = await repo.getOutbox(itemId);
    if (!item || item.txnId !== txnId || item.status !== 'pending') return 'skipped';
    const txn = await repo.getPending(txnId);
    if (!txn || txn.state !== 'new') return 'skipped';
    await repo.markOutbox(itemId, { status: 'failed' });
    await repo.upsertPending({ ...txn, error: PERMISSION_DENIED_MESSAGE });
    return 'parked';
  });
}

async function run(txnId: string, plan: ActionPlan, { repo, erp }: { repo: Repo; erp: ErpOps }, user: boolean): Promise<RunResult> {
  const found = await repo.getPending(txnId);
  if (!found) throw new Error(`Transaction ${txnId} not found`);
  let txn: PendingTxn = found;
  const id = outboxIdFor(txnId, plan);
  const stored = await repo.getOutbox(id);

  // A non-user run (the drainer) only works on an item that is still current; otherwise it changes nothing.
  if (!user && (!stored || stored.status !== 'pending')) return { status: 'failed', error: replacedError(), retryable: false };

  // Only a txn still waiting for a decision is acted on. 'created'/'submitted': the work is done (also the
  // recovery path when the txn write landed but the outbox 'done' write did not). 'ignored' (or anything
  // else): the user decided otherwise after this plan was queued, so the plan is superseded.
  if (txn.state === 'created' || txn.state === 'submitted') {
    // 'created' is reported only to the item that produced the recorded documents (its progress lists
    // them all); any other plan is refused without touching anything else.
    const mine = stored && plan.steps.length > 0 && stored.progress.stepIndex === plan.steps.length
      && txn.createdDocs.every((d) => stored.progress.created.some((c) => c.doctype === d.doctype && c.name === d.name));
    if (mine) {
      await repo.finishOutbox(id, stored.progress);
      return { status: 'created', docs: txn.createdDocs.map(({ doctype, name }) => ({ doctype, name })) };
    }
    // Stop the drainer from picking this item up again; never touch done/superseded items.
    if (stored && stored.status === 'pending') await repo.markOutbox(id, { status: 'failed' });
    const names = txn.createdDocs.map((d) => d.name).join(', ');
    return {
      status: 'failed',
      error: new ErpValidationError(`This transaction was already processed (${names}); use Undo in Activity to change it.`, 0),
      retryable: false,
    };
  }
  if (txn.state !== 'new') {
    if (txn.state === 'ignored' && plan.steps.length === 0 && !plan.needsInrAmount) {
      if (stored) await repo.finishOutbox(id, stored.progress);
      return { status: 'created', docs: [] };
    }
    await repo.markOutbox(id, { status: 'superseded' });
    const msg = `This transaction is already ${txn.state === 'ignored' ? 'ignored' : 'handled'}, so the queued entry was not created.`;
    return { status: 'failed', error: new ErpValidationError(msg, 0), retryable: false };
  }

  // Open the item (user decisions only). enqueue/reopenOutbox supersede the txn's other pending items atomically.
  if (user && !stored) {
    await repo.enqueue({ id, txnId, plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
  } else if (user && stored && stored.status !== 'pending') {
    await repo.reopenOutbox(id);
  }
  const op: Known = stored ? { progress: stored.progress, attempts: stored.attempts } : { progress: { stepIndex: 0, created: [] }, attempts: 0 };

  const bad = checkPlan(plan);
  if (bad) {
    const error = new ErpValidationError(bad, 0);
    await writeOp(repo, id, { progress: op.progress, attempts: op.attempts + 1 }, 'failed');
    await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: txn.createdDocs, error: bad });
    return { status: 'failed', error, retryable: false };
  }

  // Drafts left by replaced decisions are deleted BEFORE the new plan runs: otherwise the reference lookup
  // below would adopt them (they carry the same UTR) or they would stay in ERPNext unknown to the app.
  try {
    const keep = new Set(op.progress.created.map(docKey));
    const others = (await repo.listOutbox(txnId)).filter((o) => o.id !== id && o.status !== 'done');
    const orphans = await findOrphans(repo, erp, others, txn, keep);
    await removeOrphans(repo, erp, orphans);
    const kept = txn.createdDocs.filter((d) => keep.has(docKey(d)));
    if (kept.length !== txn.createdDocs.length) {
      await writeTxn(repo, txnId, txn, { state: txn.state, createdDocs: kept, error: txn.error });
      txn = { ...txn, createdDocs: kept };
    }
  } catch (e) {
    if (e instanceof ErpAuthError) return { status: 'needs_login' };
    if (e instanceof ErpValidationError) {
      // A submitted document blocks the new decision; the txn is left untouched.
      await repo.markOutbox(id, { status: 'failed' });
      return { status: 'failed', error: e, retryable: false };
    }
    const error = e instanceof ErpNetworkError ? e : new ErpNetworkError('Something went wrong while creating the entry. It will be retried.');
    await repo.markOutbox(id, { attempts: op.attempts + 1 });
    return { status: 'failed', error, retryable: true };
  }

  if (plan.steps.length === 0) {
    await writeTxn(repo, txnId, txn, { state: 'ignored', createdDocs: txn.createdDocs, error: null });
    await repo.finishOutbox(id, { stepIndex: 0, created: [] });
    return { status: 'created', docs: [] };
  }

  const prior = op.progress;
  const markerAfter = (i: number) => (prior.attempting !== undefined && prior.attempting > i ? { attempting: prior.attempting } : {});
  const created: DocRef[] = []; // created[i] is what step i produced or reused
  const docs: CreatedDoc[] = []; // documents that exist on the server, in step order
  const madeHere: CreatedDoc[] = []; // documents created by THIS run (the only ones compensation may delete)
  const renames = new Map<string, string>();
  let progress: Progress = { stepIndex: 0, created: [], ...(prior.attempting !== undefined ? { attempting: prior.attempting } : {}) };
  let i = 0;

  // Write-ahead marker: recorded before a server write so a retry knows the write may have happened.
  const attempt = async (step: number) => {
    progress = { stepIndex: progress.stepIndex, created: progress.created, attempting: step };
    await writeOp(repo, id, { progress, attempts: op.attempts });
  };

  // A validation or auth rejection of the create call itself means "not created": drop the marker so later
  // cleanup or recovery never mistakes someone else's document (or a namesake) for this attempt's.
  // Network and unknown errors leave the outcome unknown, so the marker stays.
  const definitive = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (e) {
      if (e instanceof ErpValidationError || e instanceof ErpAuthError) {
        progress = { stepIndex: progress.stepIndex, created: progress.created };
      }
      throw e;
    }
  };

  // KL1: a real UTR can be shared by several txns (a reversal or refund, both legs of an own-account transfer).
  /**
   * The reference hit step `i` may use, `block` when an entry with this reference must be resolved first, or
   * null to create its own document. The document an earlier attempt of this step recorded wins. Otherwise, in
   * server order (the other txns' claims are read afresh for each step):
   *  - a hit another txn lists (on the txn or in an open item's progress) is used ONLY when it is the same
   *    Internal Transfer (`shared`); otherwise it is skipped;
   *  - a hit that another txn has an unrecorded attempt for (contested) is used only when it is the planned
   *    document (samePlanned), `adopted`; otherwise skipped;
   *  - an uncontested hit nobody lists is used when it is the planned document: as this step's own lost reply
   *    when its write-ahead marker is set, else `adopted` (entered by hand);
   *  - an uncontested hit nobody lists that is NOT the planned document (or of another doctype) is never used
   *    and never silently duplicated: the first one blocks, unless a later hit is the planned document.
   * Only when every hit is listed or contested (or there are none) does this txn book its own document.
   */
  const chooseHit = async (hits: UtrHit[], step: PlanStep, at: number): Promise<{ hit: UtrHit; shared?: true; adopted?: true; block?: true } | null> => {
    const rec = at < prior.stepIndex ? prior.created[at] : undefined;
    const mine = rec && hits.find((h) => h.doctype === rec.doctype && h.name === rec.name);
    if (mine) return { hit: mine };
    if (!hits.length) return null;
    const ownMarker = prior.attempting !== undefined && prior.attempting >= at;
    const ref = referenceOf(step) as string;
    const body = applyRenames(step.body, renames);
    const foreign = await claimsOfOtherTxns(repo, txnId);
    let blocker: UtrHit | null = null;
    for (const h of hits) {
      if (foreign.docs.has(docKey(h))) {
        if (h.doctype === step.doctype && (await sameTransfer(erp, h, body))) return { hit: h, shared: true };
        continue;
      }
      const contested = foreign.attempting.has(claimKey(h.doctype, ref));
      if (await samePlanned(erp, h, step.doctype, body)) return contested || !ownMarker ? { hit: h, adopted: true } : { hit: h };
      if (!contested) blocker ??= h;
    }
    return blocker ? { hit: blocker, block: true } : null;
  };

  try {
    for (i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.kind === 'create_party') {
        const dt = step.doctype as PartyRef['doctype'];
        const refName = referencedPartyName(plan, i);
        const fromProgress = i < prior.stepIndex ? prior.created[i] : undefined;
        let ref: PartyRef | undefined = fromProgress && fromProgress.doctype === dt ? { doctype: dt, name: fromProgress.name } : undefined;
        // Recovery only: a previous attempt may have created the party (lost reply / crash before the
        // progress write). On a first attempt the user asked for a NEW party, so a namesake is not reused.
        const q = displayNameOf(step) ?? refName;
        if (!ref && q && prior.attempting !== undefined && prior.attempting >= i) {
          const hits = (await erp.searchParties(dt, q, true)).filter((h) => h.doctype === dt && norm(h.displayName) === norm(q));
          if (hits.length > 1) throw new ErpValidationError(`More than one ${dt} is named ${q}; pick the right one in ERPNext.`, 0);
          if (hits.length === 1) ref = { doctype: dt, name: hits[0].name };
        }
        if (!ref) {
          await attempt(i);
          ref = await definitive(() => erp.createParty(dt, step.body));
        }
        if (refName && ref.name !== refName) renames.set(`${dt}\u0000${refName}`, ref.name);
        created[i] = { doctype: ref.doctype, name: ref.name };
      } else {
        const hits = await erp.findDraftsByUtr(referenceOf(step) as string);
        const choice = await chooseHit(hits, step, i);
        let doc: CreatedDoc;
        if (choice) {
          const { hit } = choice;
          if (choice.block) {
            throw new ErpValidationError(
              `An entry ${hit.name} (${hit.doctype}) already exists for this reference. Open it in ERPNext and check it, or ask your accountant.`,
              0,
            );
          }
          // Found by reference, not created in this run. It is this app's own draft only when an earlier attempt
          // of this step was started (write-ahead marker) or recorded it; otherwise it was already in ERPNext
          // (the other leg of the same transfer, or entered by hand) and Undo must never delete it.
          // A step recorded earlier keeps what it recorded (an adoption stays an adoption on a retry).
          const rec = i < prior.stepIndex ? prior.created[i] : undefined;
          const ours = !choice.shared && !choice.adopted
            && (rec && rec.doctype === hit.doctype && rec.name === hit.name ? !rec.adopted : prior.attempting !== undefined && prior.attempting >= i);
          doc = { doctype: hit.doctype, name: hit.name, docstatus: hit.docstatus, ...(ours ? {} : { adopted: true }) };
        } else {
          const body = applyRenames(step.body, renames);
          delete body.docstatus; // checked above; createDraft forces 0 regardless
          await attempt(i);
          const r = await definitive(() => erp.createDraft(step.doctype, body));
          doc = { doctype: step.doctype, name: r.name, docstatus: 0 };
          madeHere.push(doc);
        }
        docs.push(doc);
        created[i] = { doctype: doc.doctype, name: doc.name, ...(doc.adopted ? { adopted: true } : {}) };
      }
      progress = { stepIndex: i + 1, created: created.slice(0, i + 1), ...markerAfter(i) };
      await writeOp(repo, id, { progress, attempts: op.attempts });
    }
  } catch (e) {
    return fail(e);
  }

  // Txn first, then the item: if the second write is lost, the next run sees 'created' and only marks it done.
  await writeTxn(repo, txnId, txn, { state: 'created', createdDocs: docs, error: null });
  await repo.finishOutbox(id, progress); // stays 'superseded' if a newer decision replaced it meanwhile
  return { status: 'created', docs: docs.map(({ doctype, name }) => ({ doctype, name })) };

  async function fail(e: unknown): Promise<RunResult> {
    // Never record less progress than was stored (a step reused from progress may fail before advancing).
    const best = progress.stepIndex >= prior.stepIndex ? progress : prior;
    if (e instanceof ErpAuthError) {
      // Credentials problem, not a data problem: keep the item queued, keep any drafts, count nothing.
      await writeOp(repo, id, { progress: best, attempts: op.attempts });
      if (docs.length) await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: txn.error });
      return { status: 'needs_login' };
    }
    if (e instanceof ErpValidationError) {
      const notes = [describeFailure(e, plan.steps[i])];
      let keep = progress.stepIndex;
      for (const d of [...madeHere].reverse()) {
        try {
          await erp.deleteDraft(d.doctype, d.name);
          docs.splice(docs.indexOf(d), 1);
          const at = created.findIndex((c) => c && c.doctype === d.doctype && c.name === d.name);
          if (at >= 0) keep = Math.min(keep, at);
        } catch (e2) {
          const why = ERP_ERROR(e2) ? e2.message : 'It could not be removed.';
          notes.push(`The draft ${d.doctype} ${d.name} was not removed: ${why} Delete or cancel it in ERPNext.`);
        }
      }
      const kept: Progress = madeHere.length
        ? { stepIndex: keep, created: created.slice(0, keep), ...(progress.attempting !== undefined ? { attempting: progress.attempting } : {}) }
        : best;
      await writeOp(repo, id, { progress: kept, attempts: op.attempts + 1 }, 'failed');
      await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: notes.join(' ') });
      return { status: 'failed', error: e, retryable: false };
    }
    // Network failures, timeouts and anything unexpected: retry later. Never delete here: if a create
    // reached the server, the retry's findDraftsByUtr finds it. An unknown error's text is not forwarded.
    const error = e instanceof ErpNetworkError ? e : new ErpNetworkError('Something went wrong while creating the entry. It will be retried.');
    await writeOp(repo, id, { progress: best, attempts: op.attempts + 1 });
    if (docs.length) await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: txn.error });
    return { status: 'failed', error, retryable: true };
  }
}

// ---------- Activity: per-txn lock for other writers, and Undo ----------

/** Runs `fn` under the same per-txn lock as runPlan, so a status poll or Undo cannot interleave with a run. */
export function withTxnLock<T>(txnId: string, fn: () => Promise<T>): Promise<T> {
  return withLock(txnId, fn);
}

export const SUBMITTED_UNDO_MESSAGE = 'Your accountant already submitted this entry. Cancel it in ERPNext if it is wrong.';
export const UNDO_FORBIDDEN_MESSAGE = 'Your ERPNext user is not allowed to delete this entry. Ask your administrator.';

export type UndoResult =
  /** `kept`: documents that were NOT deleted and stay in ERPNext (adopted, or listed by another message); only the link was removed. */
  | { status: 'undone'; kept?: { doctype: string; name: string }[] }
  | { status: 'refused'; reason: 'submitted' | 'not_found' | 'not_created'; message: string }
  | { status: 'failed'; error: ErpNetworkError | ErpValidationError; retryable: boolean }
  | { status: 'needs_login' };

export type UndoOptions = {
  /** Kept for callers ("Put back in Inbox"). Undo always re-reads every document's status; documents that are
   *  cancelled or missing are never deleted, a document that is still a draft is handled as usual. */
  docsAlreadyGone?: boolean;
};

/** Documents of `txn` that Undo may delete: created by this app for this txn and listed by no other txn. */
export async function splitRemovable(repo: Repo, txn: PendingTxn, docs: CreatedDoc[] = txn.createdDocs): Promise<{ remove: CreatedDoc[]; keep: CreatedDoc[] }> {
  const elsewhere = new Set((await repo.listPending()).filter((t) => t.id !== txn.id).flatMap((t) => t.createdDocs.map(docKey)));
  const remove: CreatedDoc[] = [];
  const keep: CreatedDoc[] = [];
  for (const d of docs) (d.adopted || elsewhere.has(docKey(d)) ? keep : remove).push(d);
  return { remove, keep };
}

/**
 * Removes the drafts this app created for a 'created' txn and returns the txn to 'new' so the user can answer
 * again. Runs under the per-txn lock and re-reads everything: only state 'created' qualifies, and every
 * document's current status is fetched right before deleting. Never deletes a submitted document, and never
 * a document it did not create (adopted by reference) or that another txn also lists: those are detached
 * (dropped from this txn's record, left in ERPNext). Never marks the txn 'new' while its own draft still exists.
 */
export function undoTxn(txnId: string, deps: { repo: Repo; erp: ErpOps }, _opts: UndoOptions = {}): Promise<UndoResult> {
  return withLock(txnId, () => undo(txnId, deps));
}

async function undo(txnId: string, { repo, erp }: { repo: Repo; erp: ErpOps }): Promise<UndoResult> {
  const txn = await repo.getPending(txnId);
  if (!txn) return { status: 'refused', reason: 'not_found', message: 'This entry was not found on this phone.' };
  if (txn.state !== 'created') {
    return { status: 'refused', reason: 'not_created', message: 'This entry is not waiting for your accountant, so there is nothing to undo.' };
  }
  const refusedSubmitted = async (docs: CreatedDoc[]): Promise<UndoResult> => {
    await writeTxn(repo, txnId, txn, { state: 'submitted', createdDocs: docs, error: null });
    return { status: 'refused', reason: 'submitted', message: SUBMITTED_UNDO_MESSAGE };
  };
  const failure = (e: unknown): UndoResult => {
    // 401: the saved login is no longer accepted. 403: this user may not do it; signing in again would not help.
    if (e instanceof ErpAuthError) {
      if (e.status === 403) return { status: 'failed', error: new ErpValidationError(UNDO_FORBIDDEN_MESSAGE, 403), retryable: false };
      return { status: 'needs_login' };
    }
    if (e instanceof ErpValidationError) return { status: 'failed', error: e, retryable: false };
    const error = e instanceof ErpNetworkError ? e : new ErpNetworkError('Something went wrong while removing the draft. Nothing was changed.');
    return { status: 'failed', error, retryable: true };
  };

  let docs = txn.createdDocs;
  // Always a fresh status of every document, even those recorded as cancelled/missing: that record may be stale.
  if (docs.length) {
    let st: Record<string, number>;
    try {
      st = await erp.getDocStatuses(docs.map(({ doctype, name }) => ({ doctype, name })));
    } catch (e) {
      return failure(e);
    }
    docs = docs.map((d) => ({ ...d, docstatus: st[docKey(d)] === undefined ? -1 : st[docKey(d)] }));
  }
  if (docs.some((d) => d.docstatus === 1)) return refusedSubmitted(docs);

  // Gone documents (missing, cancelled) are simply dropped from the record. Present drafts are deleted if they
  // are ours, otherwise detached.
  const present = docs.filter((d) => d.docstatus === 0);
  const { remove, keep } = await splitRemovable(repo, txn, present);
  let remaining = remove;
  for (const d of [...remove].reverse()) {
    try {
      await erp.deleteDraft(d.doctype, d.name);
    } catch (e) {
      if (e instanceof NotDraftError && e.docstatus === 2) {
        // cancelled meanwhile: gone
      } else if (e instanceof ErpValidationError && e.status === 404) {
        // already deleted: gone
      } else if (e instanceof NotDraftError) {
        remaining = remaining.map((x) => (x === d ? { ...x, docstatus: e.docstatus } : x));
        return refusedSubmitted(remaining);
      } else {
        // A rejected DELETE is also what the server answers when the accountant submitted in the meantime.
        if (e instanceof ErpValidationError) {
          try {
            const now = (await erp.getDocStatuses([{ doctype: d.doctype, name: d.name }]))[docKey(d)];
            if (now === 1) return refusedSubmitted(remaining.map((x) => (x === d ? { ...x, docstatus: 1 } : x)));
          } catch {
            // report the original error
          }
        }
        await writeTxn(repo, txnId, txn, { state: 'created', createdDocs: remaining, error: txn.error });
        return failure(e);
      }
    }
    remaining = remaining.filter((x) => x !== d);
  }

  // Nothing of ours is left. Retire the outbox items first so the drainer can never re-run them, then reopen the txn.
  for (const it of await repo.listOutbox(txnId)) {
    if (it.status !== 'superseded') await repo.markOutbox(it.id, { status: 'superseded', progress: withoutDocs(it) });
  }
  await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: [], error: null });
  return keep.length ? { status: 'undone', kept: keep.map(({ doctype, name }) => ({ doctype, name })) } : { status: 'undone' };
}
