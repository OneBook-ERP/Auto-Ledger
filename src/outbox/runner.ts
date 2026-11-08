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

/** The display name in the new party's fields (customer_name / supplier_name / employee_name or first + last). */
function displayNameOf(step: PlanStep): string | null {
  const f = step.body;
  const direct = f[NAME_FIELD[step.doctype]];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const full = [f.first_name, f.last_name].filter((x) => typeof x === 'string' && x.trim()).map((x) => (x as string).trim()).join(' ');
  return full || null;
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

// ---------- runner ----------

export function runPlan(txnId: string, plan: ActionPlan, deps: { repo: Repo; erp: ErpOps }): Promise<RunResult> {
  return withLock(txnId, () => run(txnId, plan, deps));
}

async function run(txnId: string, plan: ActionPlan, { repo, erp }: { repo: Repo; erp: ErpOps }): Promise<RunResult> {
  const found = await repo.getPending(txnId);
  if (!found) throw new Error(`Transaction ${txnId} not found`);
  const txn: PendingTxn = found;
  const id = outboxIdFor(txnId, plan);

  // Only a txn still waiting for a decision is acted on. 'created'/'submitted': the work is done (also the
  // recovery path when the txn write landed but the outbox 'done' write did not). 'ignored' (or anything
  // else): the user decided otherwise after this plan was queued, so the plan is superseded.
  if (txn.state === 'created' || txn.state === 'submitted') {
    await repo.markOutbox(id, { status: 'done' });
    return { status: 'created', docs: txn.createdDocs.map(({ doctype, name }) => ({ doctype, name })) };
  }
  if (txn.state !== 'new') {
    if (txn.state === 'ignored' && plan.steps.length === 0 && !plan.needsInrAmount) {
      await repo.markOutbox(id, { status: 'done' });
      return { status: 'created', docs: [] };
    }
    await repo.markOutbox(id, { status: 'superseded' });
    const msg = `This transaction is already ${txn.state === 'ignored' ? 'ignored' : 'handled'}, so the queued entry was not created.`;
    return { status: 'failed', error: new ErpValidationError(msg, 0), retryable: false };
  }

  // Open (or re-open) the outbox item; progress and attempts are read back from the database only.
  let op: Known;
  const stored = await repo.getOutbox(id);
  if (!stored) {
    await repo.enqueue({ id, txnId, plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    await repo.supersedePending(txnId, id);
    op = { progress: { stepIndex: 0, created: [] }, attempts: 0 };
  } else {
    if (stored.status !== 'pending') {
      // A user re-run of an earlier decision: it becomes the current one.
      await repo.markOutbox(id, { status: 'pending' });
      await repo.supersedePending(txnId, id);
    }
    op = { progress: stored.progress, attempts: stored.attempts };
  }

  const bad = checkPlan(plan);
  if (bad) {
    const error = new ErpValidationError(bad, 0);
    await writeOp(repo, id, { progress: op.progress, attempts: op.attempts + 1 }, 'failed');
    await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: txn.createdDocs, error: bad });
    return { status: 'failed', error, retryable: false };
  }

  if (plan.steps.length === 0) {
    await writeTxn(repo, txnId, txn, { state: 'ignored', createdDocs: [], error: null });
    await writeOp(repo, id, { progress: { stepIndex: 0, created: [] }, attempts: op.attempts }, 'done');
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
        const refName = referencedPartyName(plan, i);
        const display = displayNameOf(step);
        const fromProgress = i < prior.stepIndex ? prior.created[i] : undefined;
        let ref: PartyRef | undefined = fromProgress && fromProgress.doctype === dt ? { doctype: dt, name: fromProgress.name } : undefined;
        const q = display ?? refName;
        if (!ref && q) {
          // A series-named party (HR-EMP-00007, CUST-00042) only matches on its display name.
          const wanted = new Set([display, refName].filter((x): x is string => !!x).map(norm));
          const hits = (await erp.searchParties(dt, q)).filter((h) => h.doctype === dt);
          const hit = hits.find((h) => h.name === refName) ?? hits.find((h) => wanted.has(norm(h.displayName)));
          if (hit) ref = { doctype: dt, name: hit.name };
        }
        if (!ref) ref = await erp.createParty(dt, step.body);
        if (refName && ref.name !== refName) renames.set(`${dt}\u0000${refName}`, ref.name);
        created[i] = { doctype: ref.doctype, name: ref.name };
      } else {
        const hit = await erp.findDraftByUtr(referenceOf(step) as string);
        let doc: CreatedDoc;
        if (hit) {
          if (hit.doctype !== step.doctype) {
            throw new ErpValidationError(
              `An entry ${hit.name} (${hit.doctype}) already exists for this reference; open it in ERPNext or delete it, then try again.`,
              0,
            );
          }
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
      await writeOp(repo, id, { progress, attempts: op.attempts });
    }
  } catch (e) {
    return fail(e);
  }

  // Txn first, then the item: if the second write is lost, the next run sees 'created' and only marks it done.
  await writeTxn(repo, txnId, txn, { state: 'created', createdDocs: docs, error: null });
  await writeOp(repo, id, { progress, attempts: op.attempts }, 'done');
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
      const kept = madeHere.length ? { stepIndex: keep, created: created.slice(0, keep) } : best;
      await writeOp(repo, id, { progress: kept, attempts: op.attempts + 1 }, 'failed');
      await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: notes.join(' ') });
      return { status: 'failed', error: e, retryable: false };
    }
    // Network failures, timeouts and anything unexpected: retry later. Never delete here: if a create
    // reached the server, the retry's findDraftByUtr finds it. An unknown error's text is not forwarded.
    const error = e instanceof ErpNetworkError ? e : new ErpNetworkError('Something went wrong while creating the entry. It will be retried.');
    await writeOp(repo, id, { progress: best, attempts: op.attempts + 1 });
    if (docs.length) await writeTxn(repo, txnId, txn, { state: 'new', createdDocs: docs, error: txn.error });
    return { status: 'failed', error, retryable: true };
  }
}
