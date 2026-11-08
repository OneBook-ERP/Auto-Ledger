// Outbox runner: executes an ActionPlan against ERPNext step by step. ERPNext REST has no multi-document
// transactions, so safety comes from (1) an idempotency lookup by reference before every document create,
// (2) per-step progress persisted in the outbox, (3) compensation (deleting this run's drafts) when a step is
// rejected for good, and (4) an in-process lock per txn. Spec section 13; plan Review Focus 3, 4, 5.
//
// The runner owns the outbox item for (txnId, plan): its id is outboxIdFor(txnId, plan). A caller may
// enqueue it first under that id (for example the pipeline); otherwise runPlan enqueues it.
// It never submits a document and never logs.
import type { ActionPlan, OutboxOp, PartyRef, PendingTxn, PlanStep } from '../core/types';
import type { Repo } from '../data/repo';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../erp/client';
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

// Repo has no lookup by outbox id, so the runner remembers what it last wrote for each item, per Repo
// object. After a restart it falls back to the queue head (the drainer's retry path) and then to the
// server (party search by name, document lookup by reference), which are authoritative anyway.
// `exact` is false when the stored item could not be read back: failure paths then avoid overwriting
// its progress/attempts with values that might be older than what is stored.
type Known = { progress: Progress; attempts: number; exact?: boolean };
const known = new WeakMap<Repo, Map<string, Known>>();

function knownFor(repo: Repo): Map<string, Known> {
  let m = known.get(repo);
  if (!m) known.set(repo, (m = new Map()));
  return m;
}

async function openOp(repo: Repo, id: string, txnId: string, plan: ActionPlan): Promise<Known> {
  const fresh: Known = { progress: { stepIndex: 0, created: [] }, attempts: 0, exact: true };
  try {
    await repo.enqueue({ id, txnId, plan, progress: fresh.progress, attempts: 0, status: 'pending' });
    knownFor(repo).set(id, fresh);
    return fresh;
  } catch (e) {
    if (!(e instanceof Error) || !/UNIQUE/i.test(e.message)) throw e;
  }
  let k = knownFor(repo).get(id);
  if (!k) {
    const head = await repo.nextOutbox();
    k = head && head.id === id
      ? { progress: head.progress, attempts: head.attempts, exact: true }
      : { progress: { stepIndex: 0, created: [] }, attempts: 0, exact: false };
  }
  await repo.markOutbox(id, { status: 'pending' });
  knownFor(repo).set(id, k);
  return k;
}

async function writeOp(repo: Repo, id: string, k: Known, status?: OutboxOp['status']): Promise<void> {
  await repo.markOutbox(id, { progress: k.progress, attempts: k.attempts, ...(status ? { status } : {}) });
  knownFor(repo).set(id, { ...k, exact: true });
}

/** Failure-path write: when the stored item was not readable, write only what cannot regress it. */
async function writeFailedOp(repo: Repo, id: string, op: Known, progress: Progress, bump: number, status?: OutboxOp['status']) {
  if (op.exact) return writeOp(repo, id, { progress, attempts: op.attempts + bump }, status);
  await repo.markOutbox(id, { ...(progress.stepIndex > 0 ? { progress } : {}), ...(status ? { status } : {}) });
  knownFor(repo).delete(id);
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

/** The party name the later document steps refer to, else the display name in the party fields. */
function plannedPartyName(plan: ActionPlan, i: number): string | null {
  const dt = plan.steps[i].doctype;
  for (const s of plan.steps.slice(i + 1)) {
    if (s.kind !== 'create_doc') continue;
    if (s.body.party_type === dt && typeof s.body.party === 'string') return s.body.party;
    const rows = Array.isArray(s.body.accounts) ? (s.body.accounts as Record<string, unknown>[]) : [];
    const row = rows.find((r) => r && r.party_type === dt && typeof r.party === 'string');
    if (row) return row.party as string;
  }
  const f = plan.steps[i].body;
  const direct = f[NAME_FIELD[dt]];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const full = [f.first_name, f.last_name].filter((x) => typeof x === 'string' && x.trim()).join(' ');
  return full || null;
}

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

// ---------- runner ----------

export function runPlan(txnId: string, plan: ActionPlan, deps: { repo: Repo; erp: ErpOps }): Promise<RunResult> {
  return withLock(txnId, () => run(txnId, plan, deps));
}

async function run(txnId: string, plan: ActionPlan, { repo, erp }: { repo: Repo; erp: ErpOps }): Promise<RunResult> {
  const found = await repo.getPending(txnId);
  if (!found) throw new Error(`Transaction ${txnId} not found`);
  const txn: PendingTxn = found;
  const id = outboxIdFor(txnId, plan);

  // Already done (for example the second of two parallel runs): report it, touch nothing on the server.
  if ((txn.state === 'created' || txn.state === 'submitted') && txn.createdDocs.length) {
    await repo.markOutbox(id, { status: 'done' });
    return { status: 'created', docs: txn.createdDocs.map(({ doctype, name }) => ({ doctype, name })) };
  }

  const op = await openOp(repo, id, txnId, plan);

  const bad = checkPlan(plan);
  if (bad) {
    const error = new ErpValidationError(bad, 0);
    await writeFailedOp(repo, id, op, op.progress, 1, 'failed');
    await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: txn.createdDocs, error: bad });
    return { status: 'failed', error, retryable: false };
  }

  if (plan.steps.length === 0) {
    await writeOp(repo, id, { progress: { stepIndex: 0, created: [] }, attempts: op.attempts }, 'done');
    await writeTxn(repo, txnId, txn, { state: 'ignored', createdDocs: [], error: null });
    return { status: 'created', docs: [] };
  }

  const prior = op.progress;
  const created: DocRef[] = []; // created[i] is what step i produced or reused
  const docs: CreatedDoc[] = []; // documents that exist on the server, in step order
  const madeHere: CreatedDoc[] = []; // documents created by THIS run (the only ones compensation may delete)
  const renames = new Map<string, string>();
  let progress: Progress = { stepIndex: 0, created: [] };
  let i = 0;

  try {
    for (i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      if (step.kind === 'create_party') {
        const dt = step.doctype as PartyRef['doctype'];
        const planned = plannedPartyName(plan, i);
        const fromProgress = i < prior.stepIndex ? prior.created[i] : undefined;
        let ref: PartyRef | undefined = fromProgress && fromProgress.doctype === dt ? { doctype: dt, name: fromProgress.name } : undefined;
        if (!ref && planned) {
          const hits = await erp.searchParties(dt, planned);
          ref = hits.find((h) => h.doctype === dt && h.name === planned);
        }
        if (!ref) ref = await erp.createParty(dt, step.body);
        if (planned && ref.name !== planned) renames.set(`${dt}\u0000${planned}`, ref.name);
        created[i] = { doctype: ref.doctype, name: ref.name };
      } else {
        const hit = await erp.findDraftByUtr(referenceOf(step) as string);
        let doc: CreatedDoc;
        if (hit) {
          doc = { doctype: hit.doctype, name: hit.name, docstatus: hit.docstatus };
        } else {
          const body = applyRenames(step.body, renames);
          delete body.docstatus; // checked above; createDraft forces 0 regardless
          const r = await erp.createDraft(step.doctype, body);
          doc = { doctype: step.doctype, name: r.name, docstatus: 0 };
          madeHere.push(doc);
        }
        docs.push(doc);
        created[i] = { doctype: doc.doctype, name: doc.name };
      }
      progress = { stepIndex: i + 1, created: created.slice(0, i + 1) };
      if (op.exact) await writeOp(repo, id, { progress, attempts: op.attempts });
      else await repo.markOutbox(id, { progress });
    }
  } catch (e) {
    return fail(e);
  }

  await writeOp(repo, id, { progress, attempts: op.attempts }, 'done');
  await writeTxn(repo, txnId, txn, { state: 'created', createdDocs: docs, error: null });
  return { status: 'created', docs: docs.map(({ doctype, name }) => ({ doctype, name })) };

  async function fail(e: unknown): Promise<RunResult> {
    if (e instanceof ErpAuthError) {
      // Credentials problem, not a data problem: keep the item queued, keep any drafts, count nothing.
      await writeFailedOp(repo, id, op, progress, 0);
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
      await writeFailedOp(repo, id, op, { stepIndex: keep, created: created.slice(0, keep) }, 1, 'failed');
      await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: notes.join(' ') });
      return { status: 'failed', error: e, retryable: false };
    }
    // Network failures, timeouts and anything unexpected: retry later. Never delete here: if a create
    // reached the server, the retry's findDraftByUtr finds it. An unknown error's text is not forwarded.
    const error = e instanceof ErpNetworkError ? e : new ErpNetworkError('Something went wrong while creating the entry. It will be retried.');
    await writeFailedOp(repo, id, op, progress, 1);
    if (docs.length) await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: txn.error });
    return { status: 'failed', error, retryable: true };
  }
}
