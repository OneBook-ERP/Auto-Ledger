// Ingestion pipeline: native queue / inbox backfill -> parse -> account check -> correlate -> repo -> ack.
//
// Contract with the native module (R39): peek() never removes anything; an item is acked only after every
// repo write it needs has succeeded. An exception on one item leaves it in the queue (re-processed next time)
// and never blocks the others. Every step is idempotent: an insert uses the id t_<rawHash> and is skipped
// when that SMS is already stored; a correlation write (enrich / paired / empty_patch) records the merged
// SMS in the same transaction (Repo.mergeInto), so re-processing after a crash between the write and the ack,
// or seeing the same SMS again via backfill, changes nothing. Raw bodies are never persisted or logged; only
// the parsed fields are stored.
//
// Everything takes injected deps (repo, native bridge, erp, now) and nothing is created at import time.
// App wiring (Task 16): create the Repo exactly once app-wide on the single SQLite connection and pass that
// same instance everywhere, because the Repo mutex and the locks below are per Repo instance.
//
// Known limitations (documented, not fixed in phase 1):
// - The Repo mutex and the ingest/drain locks here are per Repo instance and per JS process. There is no
//   durable cross-process claim: phase 1 runs the pipeline only in the foreground app.
// - The runner's txn writes (re-read then upsert) are not atomic with mergeInto; an enrichment landing
//   between the two can be overwritten by the runner's write of the pre-enrichment fields. Rare (foreground
//   only), and the next SMS for that txn is not affected.
// - Real UTRs can be shared across txns (KL1/KL2); correlation and the runner's reference lookup can then
//   pick the wrong partner/document. Tracked for Task 20.
// - The `merged_sms:<hash>` markers in settings grow by one row per merged SMS and are never pruned.
// - unrecognised_count can over-count if the process dies between its write and the ack (display only).
import type { AccountMapping, ParsedTxn, PendingTxn, TemplateSet } from '../core/types';
import { correlate } from '../core/correlate';
import { parseSms } from '../core/parser';
import type { Repo } from '../data/repo';
import type {
  EngineHealth, PermissionState, QueuedSms, RawSms, TemplatesInfo,
} from '../../modules/sms-ingest/src';
import { loadTemplates } from './templates';
import { drainOutbox, type DrainErp, type DrainResult } from './drain';

export type { DrainErp, DrainResult } from './drain';

/** The native SmsIngest bridge (modules/sms-ingest/src); `import * as SmsIngest` satisfies it. */
export interface NativeBridge {
  peek(): Promise<QueuedSms[]>;
  ack(ids: string[]): Promise<void>;
  backfill(days: number, senderPatterns: string[]): Promise<RawSms[]>;
  setSenderPatterns(patterns: string[]): Promise<void>;
  getSenderPatterns(): Promise<string[]>;
  setTemplates(json: string): Promise<boolean>;
  getTemplatesInfo(): Promise<TemplatesInfo>;
  engineHealth(): Promise<EngineHealth>;
  hasPermission(): Promise<PermissionState>;
  droppedCount(): Promise<number>;
}

export type PipelineDeps = { repo: Repo; native: NativeBridge; erp: DrainErp; now: () => number; fetchImpl?: typeof fetch };

export type IngestResult = {
  inserted: number; enriched: number; duplicates: number; ignored: number; unrecognised: number;
  unmappedAccounts: string[]; errors: number;
};
export type BackfillResult = IngestResult & { backfillSkipped?: 'no_permission' | 'no_mappings' };

export const BACKFILL_DAYS = 7;
export const UNRECOGNISED_COUNT_KEY = 'unrecognised_count';
export const BACKFILL_DONE_AT_KEY = 'backfill_done_at';
export const unrecognisedAccountKey = (last4: string) => `unrecognised_account:${last4}`;
const CORRELATE_LOOKBACK_MS = 7 * 24 * 3600_000;
const NATIVE_UNRECOGNISED = 'unrecognised';

const emptyResult = (): IngestResult => ({
  inserted: 0, enriched: 0, duplicates: 0, ignored: 0, unrecognised: 0, unmappedAccounts: [], errors: 0,
});

// ---------- accounts ----------

const senderMatches = (m: AccountMapping, sender: string) =>
  m.senderIds.some((s) => s.trim() !== '' && sender.toLowerCase().includes(s.trim().toLowerCase()));

/**
 * The mapping a parsed txn belongs to (R10): same kind, sender matching one of its senderIds, and its
 * last-4 listed. With no last-4 (IMPS, SI) the only mapping of that kind, or null when there are several or
 * none (the UI then asks the user).
 */
export function resolveMapping(mappings: AccountMapping[], txn: ParsedTxn): AccountMapping | null {
  const cands = mappings.filter((m) => m.kind === txn.accountType && senderMatches(m, txn.sender));
  if (txn.accountLast4 === null) return cands.length === 1 ? cands[0] : null;
  return cands.find((m) => m.last4.includes(txn.accountLast4 as string)) ?? null;
}

/** Union of all mappings' senderIds (trimmed, deduplicated, sorted). */
function senderPatternsOf(mappings: AccountMapping[]): string[] {
  const out: string[] = [];
  for (const m of mappings) {
    for (const s of m.senderIds) {
      const p = s.trim();
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out.sort();
}

/**
 * Hands the union of all mappings' senderIds to the native receiver (R6); [] without mappings. The receiver
 * stores nothing until this is called, so the app calls it after setup and on every launch.
 */
export async function syncSenderPatterns(deps: { repo: Repo; native: Pick<NativeBridge, 'setSenderPatterns'> }): Promise<string[]> {
  const patterns = senderPatternsOf(await deps.repo.listMappings());
  await deps.native.setSenderPatterns(patterns);
  return patterns;
}

// ---------- per-repo serialisation ----------

const chains = new WeakMap<Repo, Promise<unknown>>();

/** Runs ingest/backfill batches of one Repo one at a time (correlation reads and writes must not interleave). */
function serial<T>(repo: Repo, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(repo) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(repo, run.then(() => undefined, () => undefined));
  return run;
}

// ---------- processing ----------

type Sms = { sender: string; body: string; receivedAt: number };
type Outcome = 'inserted' | 'enriched' | 'duplicate' | 'ignored' | 'unrecognised' | { unmapped: string };

class Batch {
  readonly result = emptyResult();
  private pending: PendingTxn[] = [];
  private mappings: AccountMapping[] = [];
  private templates!: TemplateSet;

  constructor(private readonly repo: Repo, private readonly now: () => number) {}

  async load(): Promise<void> {
    this.templates = await loadTemplates(this.repo);
    this.mappings = await this.repo.listMappings();
    this.pending = await this.repo.listPending();
  }

  /** Parses and stores one SMS. Throws on a storage failure (the caller then does not ack it). */
  async process(sms: Sms, nativeKind: string | null): Promise<Outcome> {
    const r = parseSms(sms.sender, sms.body, sms.receivedAt, this.templates);
    if (!r.ok) {
      // A native "unrecognised" item is a money-like SMS the native engine could not read; when TS cannot
      // read it either it is counted for the "N messages could not be read" notice.
      return nativeKind === NATIVE_UNRECOGNISED ? 'unrecognised' : 'ignored';
    }
    const txn = r.txn;

    if (!this.mappings.some((m) => senderMatches(m, txn.sender))) return 'ignored';
    if (txn.accountLast4 !== null && !resolveMapping(this.mappings, txn)) {
      const key = unrecognisedAccountKey(txn.accountLast4);
      if ((await this.repo.getSetting(key)) === null) await this.repo.setSetting(key, String(this.now()));
      return { unmapped: txn.accountLast4 };
    }

    // Already stored (any age) or already merged into another txn: the same SMS again.
    if (this.pending.some((p) => p.rawHash === txn.rawHash) || (await this.repo.isMergedSms(txn.rawHash))) return 'duplicate';

    const existing = this.pending.filter((p) => Math.abs(p.receivedAt - txn.receivedAt) <= CORRELATE_LOOKBACK_MS);
    const c = correlate(existing, txn);
    if (c.action === 'drop_duplicate' && c.reason === 'same_sms') return 'duplicate';
    if (c.action === 'drop_duplicate' || c.action === 'enrich') {
      const target = c.action === 'enrich' ? c.target : c.of;
      const patch = c.action === 'enrich' ? c.patch : {};
      const m = await this.repo.mergeInto(target, patch, txn.rawHash);
      if (m.status === 'merged') this.replace(m.txn);
      if (m.status !== 'merged' || c.action === 'drop_duplicate') return 'duplicate';
      return 'enriched';
    }

    const id = `t_${txn.rawHash}`;
    const stored = await this.repo.getPending(id);
    if (stored) {
      this.replace(stored);
      return 'duplicate';
    }
    const row: PendingTxn = { ...txn, id, state: 'new', createdDocs: [], error: null, mergedCount: 1 };
    await this.repo.upsertPending(row);
    this.pending.push(row);
    return 'inserted';
  }

  count(o: Outcome): void {
    const r = this.result;
    if (typeof o === 'object') {
      if (!r.unmappedAccounts.includes(o.unmapped)) r.unmappedAccounts.push(o.unmapped);
    } else if (o === 'inserted') r.inserted++;
    else if (o === 'enriched') r.enriched++;
    else if (o === 'duplicate') r.duplicates++;
    else if (o === 'ignored') r.ignored++;
    else r.unrecognised++;
  }

  private replace(t: PendingTxn): void {
    const i = this.pending.findIndex((p) => p.id === t.id);
    if (i >= 0) this.pending[i] = t;
    else this.pending.push(t);
  }
}

const oldestFirst = <T extends { receivedAt: number }>(xs: T[]) => [...xs].sort((a, b) => a.receivedAt - b.receivedAt);

/**
 * Drains the native queue: peek -> parse -> correlate -> repo -> ack (only fully processed items). OTP,
 * ignore, non-money, unknown-template and unknown-sender items are acked and dropped; native "unrecognised"
 * items TS cannot parse either are acked and added to `unrecognised_count`; an SMS from an unmapped account
 * (known sender, unknown last-4) is acked, not stored, and flags `unrecognised_account:<last4>` once.
 */
export function ingest(deps: { repo: Repo; native: Pick<NativeBridge, 'peek' | 'ack'>; now: () => number }): Promise<IngestResult> {
  return serial(deps.repo, async () => {
    const items = await deps.native.peek();
    if (!items.length) return emptyResult();
    const batch = new Batch(deps.repo, deps.now);
    await batch.load();
    const done: string[] = [];
    const unrecognisedIds: string[] = [];
    for (const q of oldestFirst(items)) {
      try {
        const o = await batch.process(q, q.kind);
        batch.count(o);
        (o === 'unrecognised' ? unrecognisedIds : done).push(q.id);
      } catch {
        batch.result.errors++;
      }
    }
    if (unrecognisedIds.length) {
      try {
        const cur = parseInt((await deps.repo.getSetting(UNRECOGNISED_COUNT_KEY)) ?? '0', 10) || 0;
        await deps.repo.setSetting(UNRECOGNISED_COUNT_KEY, String(cur + unrecognisedIds.length));
        done.push(...unrecognisedIds);
      } catch {
        batch.result.errors += unrecognisedIds.length;
      }
    }
    if (done.length) {
      try {
        await deps.native.ack(done);
      } catch {
        batch.result.errors += done.length; // re-processed (idempotently) next time
      }
    }
    return batch.result;
  });
}

/**
 * Reads the last 7 days of the inbox for the configured senders and runs every message through the same
 * path as live items (nothing is acked: backfilled SMS are not in the native queue; rawHash dedupe makes the
 * overlap harmless). Runs after setup and on every app open; records `backfill_done_at`. Skips silently
 * without READ_SMS ('no_permission') or without mappings ('no_mappings').
 */
export function ensureBackfill(deps: {
  repo: Repo; native: Pick<NativeBridge, 'hasPermission' | 'backfill'>; now: () => number;
}): Promise<BackfillResult> {
  return serial(deps.repo, async () => {
    const perm = await deps.native.hasPermission();
    if (!perm.read) return { ...emptyResult(), backfillSkipped: 'no_permission' as const };
    const patterns = senderPatternsOf(await deps.repo.listMappings());
    if (!patterns.length) return { ...emptyResult(), backfillSkipped: 'no_mappings' as const };
    const raws = await deps.native.backfill(BACKFILL_DAYS, patterns);
    const batch = new Batch(deps.repo, deps.now);
    await batch.load();
    for (const raw of oldestFirst(raws)) {
      try {
        const o = await batch.process(raw, null);
        batch.count(o);
      } catch {
        batch.result.errors++;
      }
    }
    await deps.repo.setSetting(BACKFILL_DONE_AT_KEY, String(deps.now()));
    return batch.result;
  });
}

export type CycleStep = 'syncSenderPatterns' | 'ingest' | 'ensureBackfill' | 'drainOutbox';
export type CycleSummary = {
  senderPatterns?: string[];
  ingest?: IngestResult;
  backfill?: BackfillResult;
  drain?: DrainResult;
  failedSteps: CycleStep[];
};

/**
 * What the app runs on foreground and after setup: syncSenderPatterns -> ingest -> ensureBackfill ->
 * drainOutbox. A failing step is recorded in `failedSteps` and never skips the rest. Never throws.
 */
export async function runForegroundCycle(deps: PipelineDeps): Promise<CycleSummary> {
  const out: CycleSummary = { failedSteps: [] };
  const step = async <T>(name: CycleStep, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch {
      out.failedSteps.push(name);
      return undefined;
    }
  };
  out.senderPatterns = await step('syncSenderPatterns', () => syncSenderPatterns(deps));
  out.ingest = await step('ingest', () => ingest(deps));
  out.backfill = await step('ensureBackfill', () => ensureBackfill(deps));
  out.drain = await step('drainOutbox', () => drainOutbox(deps));
  return out;
}
