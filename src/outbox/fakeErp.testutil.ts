// Test-only fake of the ERPNext document operations used by Activity (status poll and Undo).
import { ErpValidationError } from '../erp/client';
import { NotDraftError } from '../erp/docs';
import type { ErpOps } from './erpOps';

export type FakeOpName = 'getDocStatuses' | 'deleteDraft';

/** docs: `${doctype}:${name}` -> docstatus. A key that is absent models "deleted or not accessible". */
export class FakeDocsErp implements Pick<ErpOps, 'getDocStatuses' | 'deleteDraft'> {
  docs = new Map<string, number>();
  calls: { op: FakeOpName; args: unknown[] }[] = [];
  private failures: { op: FakeOpName; error: Error }[] = [];
  /** Awaited at the start of every call of that op (gate a call to interleave other work). */
  /** Persistent per-document delete failure (by name) until removed. */
  /** Names that the accountant submits at the moment of DELETE: the server rejects it like the real one (417). */
  submitOnDelete = new Set<string>();
  private waiters: { op: FakeOpName; n: number; resolve: () => void }[] = [];
  /** Resolves once `op` has been called `n` times (explicit synchronisation for race tests). */
  called(op: FakeOpName, n = 1): Promise<void> {
    if (this.count(op) >= n) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ op, n, resolve }));
  }
  failDeleteOf = new Map<string, Error>();
  gates: Partial<Record<FakeOpName, () => Promise<void>>> = {};
  /** Runs right after getDocStatuses has read its answer (models a doc changing after the read). */
  afterStatuses?: () => void | Promise<void>;

  constructor(docs: Record<string, number> = {}) {
    for (const [k, v] of Object.entries(docs)) this.docs.set(k, v);
  }
  failNext(op: FakeOpName, error: Error) { this.failures.push({ op, error }); }
  count(op: FakeOpName) { return this.calls.filter((c) => c.op === op).length; }
  private async enter(op: FakeOpName, args: unknown[]) {
    this.calls.push({ op, args });
    this.waiters = this.waiters.filter((w) => (w.op === op && this.count(op) >= w.n ? (w.resolve(), false) : true));
    if (this.gates[op]) await this.gates[op]!();
    const i = this.failures.findIndex((f) => f.op === op);
    if (i >= 0) throw this.failures.splice(i, 1)[0].error;
  }
  async getDocStatuses(refs: { doctype: string; name: string }[]) {
    await this.enter('getDocStatuses', [refs]);
    const out: Record<string, number> = {};
    for (const r of refs) {
      const k = `${r.doctype}:${r.name}`;
      if (this.docs.has(k)) out[k] = this.docs.get(k)!;
    }
    await this.afterStatuses?.();
    return out;
  }
  async deleteDraft(doctype: string, name: string) {
    await this.enter('deleteDraft', [doctype, name]);
    if (this.submitOnDelete.has(name) && this.docs.has(`${doctype}:${name}`)) {
      this.docs.set(`${doctype}:${name}`, 1);
      throw new ErpValidationError('Submitted documents cannot be deleted', 417);
    }
    if (this.failDeleteOf.has(name)) throw this.failDeleteOf.get(name)!;
    const k = `${doctype}:${name}`;
    const ds = this.docs.get(k);
    if (ds === undefined) throw new ErpValidationError('not found', 404);
    if (ds !== 0) throw new NotDraftError(doctype, name, ds);
    this.docs.delete(k);
  }
}
