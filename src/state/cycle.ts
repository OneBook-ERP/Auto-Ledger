import type { AppStateStatus } from 'react-native';
import type { Repo } from '../data/repo';
import { cycleCountsAsSynced, LAST_SYNCED_KEY } from '../home/viewModel';
import type { CycleSummary } from '../ingest/pipeline';

export type CycleRunner = { trigger(): Promise<void> };

/**
 * Runs the foreground cycle one at a time: a trigger while a cycle is running joins it (no overlap, no
 * queueing). `after` runs once per finished cycle (banner refresh). Never rejects.
 */
export type CycleOutcome = CycleSummary & { skipped?: 'site_mismatch' };

export function createCycleRunner(opts: { run: () => Promise<CycleOutcome>; after: (s: CycleOutcome | null) => Promise<void> }): CycleRunner {
  let inFlight: Promise<void> | null = null;
  return {
    trigger() {
      if (inFlight) return inFlight;
      const p = (async () => {
        let summary: CycleOutcome | null = null;
        try {
          summary = await opts.run();
        } catch {
          summary = null;
        }
        try {
          await opts.after(summary);
        } catch {
          // banner refresh is best effort
        }
      })().finally(() => {
        inFlight = null;
      });
      inFlight = p;
      return p;
    },
  };
}

type AppStateLike = { addEventListener(type: 'change', cb: (s: AppStateStatus) => void): { remove(): void } };

/** Triggers the cycle every time the app returns to the foreground. Returns the detach function. */
export function attachAppStateCycle(runner: CycleRunner, appState: AppStateLike): () => void {
  const sub = appState.addEventListener('change', (s) => {
    if (s === 'active') void runner.trigger();
  });
  return () => sub.remove();
}

export type AfterCycleDeps = {
  repo: Pick<Repo, 'setSetting'> | null;
  now: () => number;
  refreshBanners: () => Promise<void>;
  /** Re-reads Home (drafts, answers, sync time). Runs whatever happened before it (finally). */
  invalidateHome: () => unknown;
  /**
   * The "may already be booked" check (warn only, src/ingest/dupCheck.ts). Runs only when ERPNext answered
   * during the cycle, after Home is invalidated; a failure is swallowed and never blocks the cycle.
   */
  checkDuplicates?: () => Promise<void>;
  /**
   * Automatic answers for confirmed patterns (src/ingest/autoApply.ts), after the duplicate check so its warnings
   * are fresh. Same condition (ERPNext answered, same site); runs inside the cycle, so never next to another step.
   * Resolves to how many items were answered; a failure is swallowed.
   */
  autoApply?: () => Promise<number | void>;
};

/**
 * End of a foreground cycle: records Home's "last synced" when the cycle counts as synced (spec section 14,
 * R50), refreshes the banners, and ALWAYS invalidates Home, even when the banner refresh rejects.
 */
export async function afterCycle(summary: CycleOutcome | null, d: AfterCycleDeps): Promise<void> {
  try {
    if (d.repo && cycleCountsAsSynced(summary)) {
      try {
        await d.repo.setSetting(LAST_SYNCED_KEY, String(d.now()));
      } catch {
        // best effort
      }
    }
    await d.refreshBanners();
  } finally {
    try {
      const r = d.invalidateHome();
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(() => undefined);
    } catch {
      // best effort
    }
    const reached = summary?.erpReached === true && !summary.skipped;
    if (d.checkDuplicates && reached) {
      try {
        await d.checkDuplicates();
      } catch {
        // warnings are best effort
      }
    }
    if (d.autoApply && reached) {
      try {
        const n = await d.autoApply();
        if (n) {
          const r = d.invalidateHome();
          if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(() => undefined);
        }
      } catch {
        // automatic answers are best effort; the items wait in the Inbox
      }
    }
  }
}
