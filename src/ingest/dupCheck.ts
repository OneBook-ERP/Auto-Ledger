// "May already be booked" check (wave 3, WARN ONLY): once per cycle, reads the company's booked entries for the
// span of pending items in ONE batch and stores a flag per pending item that looks like one of them. Flags never
// block, hide or change an answer; the runner's own duplicate safety (20A) is separate and unchanged.
// Uses parsed fields only (no SMS text). Never throws.
import { SIMILAR_DAYS, dayNumber, findSimilar, type BookedEntry, type SimilarHit } from '../core/similar';
import type { Repo } from '../data/repo';
import type { ErpClient } from '../erp/client';
import { listBookedEntries } from '../erp/docs';

/** Setting `possible_duplicate:<txnId>` holds a DupFlag as JSON. */
export const DUP_KEY_PREFIX = 'possible_duplicate:';
export const dupKey = (txnId: string) => `${DUP_KEY_PREFIX}${txnId}`;

/** The company setting (same key as COMPANY_KEY in src/state/useSetting, which this module must not import). */
export const COMPANY_SETTING = 'company';

export type DupFlag = { doctype: string; name: string; strength: SimilarHit['strength'] };

export function parseDupFlag(v: string | null | undefined): DupFlag | null {
  if (!v) return null;
  try {
    const o = JSON.parse(v) as Partial<DupFlag> | null;
    if (!o || typeof o.doctype !== 'string' || !o.doctype || typeof o.name !== 'string' || !o.name) return null;
    if (o.strength !== 'strong' && o.strength !== 'weak') return null;
    return { doctype: o.doctype, name: o.name, strength: o.strength };
  } catch {
    return null;
  }
}

export type DupCheckDeps = {
  repo: Pick<Repo, 'listPending' | 'listQueuedTxnIds' | 'getSetting' | 'setSetting' | 'deleteSetting' | 'listSettings'>;
  erp: { listBookedEntries(company: string, fromDate: string, toDate: string): Promise<BookedEntry[]> };
};

const DAY_MS = 86_400_000;
const isoOfDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * Pending = state 'new' and no answer waiting in the outbox. Flags of anything else (answered, ignored, queued,
 * gone) are removed first, locally. Then the booked entries between the earliest pending date - 3 days and the
 * latest + 3 days are read once; each pending item's flag is set, updated or removed. If ERPNext fails, the
 * pending items' flags are left as they were.
 */
export async function runDupCheck(deps: DupCheckDeps): Promise<void> {
  const { repo } = deps;
  try {
    const queued = new Set(await repo.listQueuedTxnIds());
    const pending = (await repo.listPending('new')).filter((t) => !queued.has(t.id));
    const ids = new Set(pending.map((t) => t.id));
    const stored = new Map<string, string>();
    for (const s of await repo.listSettings(DUP_KEY_PREFIX)) {
      const id = s.key.slice(DUP_KEY_PREFIX.length);
      if (ids.has(id)) stored.set(id, s.value);
      else await repo.deleteSetting(s.key);
    }
    if (!pending.length) return;
    const company = await repo.getSetting(COMPANY_SETTING);
    if (!company) return;

    const days = pending.map((t) => dayNumber(t.occurredOn)).filter((d): d is number => d !== null);
    if (!days.length) return;
    const from = isoOfDay(Math.min(...days) - SIMILAR_DAYS);
    const to = isoOfDay(Math.max(...days) + SIMILAR_DAYS);
    const entries = await deps.erp.listBookedEntries(company, from, to);

    for (const t of pending) {
      const hit = findSimilar(t, entries);
      const key = dupKey(t.id);
      try {
        if (!hit) {
          if (stored.has(t.id)) await repo.deleteSetting(key);
          continue;
        }
        const value = JSON.stringify({ doctype: hit.entry.doctype, name: hit.entry.name, strength: hit.strength } satisfies DupFlag);
        if (stored.get(t.id) !== value) await repo.setSetting(key, value);
      } catch {
        // one local write failing must not stop the others
      }
    }
  } catch {
    // offline, signed out, server error, local read error: warnings are best effort; the next cycle tries again
  }
}

/** The check bound to a real client (the app's cycle wiring). */
export function dupCheckWith(repo: DupCheckDeps['repo'], client: ErpClient): () => Promise<void> {
  return () => runDupCheck({ repo, erp: { listBookedEntries: (company, from, to) => listBookedEntries(client, company, from, to) } });
}
