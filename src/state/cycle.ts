import type { AppStateStatus } from 'react-native';
import type { Repo } from '../data/repo';
import { cycleCountsAsSynced, LAST_SYNCED_KEY } from '../home/viewModel';
import type { CycleSummary } from '../ingest/pipeline';

/**
 * `trigger()` starts a cycle and resolves once the cycle and `after` (sync time, banners, Home) are done, so
 * pull-to-refresh ends there. `idle()` resolves once the slow `background` step that follows (duplicate check,
 * automatic answers) has ended too.
 */
export type CycleRunner = { trigger(): Promise<void>; idle(): Promise<void> };

export type CycleOutcome = CycleSummary & { skipped?: 'site_mismatch' };

/**
 * Runs the foreground cycle one at a time: a trigger while a cycle OR its background step is running joins it (no
 * overlap with the background's writes, no second background step, no queueing; while the background step runs the
 * trigger resolves at once). `after` runs once per finished cycle; `background` runs after it, outside what the
 * trigger waits for. Never rejects; failures of `after` and `background` are swallowed.
 */
export function createCycleRunner(opts: {
  run: () => Promise<CycleOutcome>;
  after: (s: CycleOutcome | null) => Promise<void>;
  background?: (s: CycleOutcome | null) => Promise<void>;
}): CycleRunner {
  /** What a trigger waits for (cycle + after). */
  let visible: Promise<void> | null = null;
  /** Everything, background included; the runner is busy until it settles. */
  let whole: Promise<void> | null = null;
  return {
    trigger() {
      if (visible) return visible;
      let summary: CycleOutcome | null = null;
      const v = (async () => {
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
      })();
      const background = opts.background;
      const free = () => {
        visible = null;
        whole = null;
      };
      if (!background) {
        const done = v.finally(free);
        visible = done;
        whole = done;
        return done;
      }
      const w = v
        .then(() => background(summary))
        .catch(() => undefined) // the background step is best effort
        .finally(free);
      visible = v;
      whole = w;
      return v;
    },
    idle() {
      return whole ?? Promise.resolve();
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
} & Partial<Omit<BackgroundDeps, 'onDone'>>;

export type BackgroundDeps = {
  /**
   * The "may already be booked" check (warn only, src/ingest/dupCheck.ts). Runs only when ERPNext answered
   * during the cycle; a failure is swallowed and never blocks anything.
   */
  checkDuplicates?: () => Promise<boolean | void>;
  /**
   * Automatic answers for confirmed patterns (src/ingest/autoApply.ts), after the duplicate check so its warnings
   * are fresh. Runs only when that check really ran (it resolved true). Resolves to how many items were answered;
   * a failure is swallowed.
   */
  autoApply?: () => Promise<number | void>;
  /** Called once the steps that ran are over, with how many items were answered (screens re-read). */
  onDone?: (answered: number) => unknown;
};

/**
 * The slow steps after a cycle: the duplicate check, then automatic answers. In the app this runs as the cycle
 * runner's `background` step (pull-to-refresh does not wait for it, and it never overlaps another cycle). Never
 * rejects.
 */
export async function afterCycleBackground(summary: CycleOutcome | null, d: BackgroundDeps): Promise<void> {
  const reached = summary?.erpReached === true && !summary.skipped;
  if (!reached || !d.checkDuplicates) return;
  let dupChecked = false;
  try {
    dupChecked = (await d.checkDuplicates()) === true;
  } catch {
    // warnings are best effort
  }
  let answered = 0;
  if (d.autoApply && dupChecked) {
    try {
      answered = Number(await d.autoApply()) || 0;
    } catch {
      // automatic answers are best effort; the items wait in the Inbox
    }
  }
  try {
    const r = d.onDone?.(answered);
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(() => undefined);
  } catch {
    // best effort
  }
}

const quietly = (f: () => unknown) => {
  try {
    const r = f();
    if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(() => undefined);
  } catch {
    // best effort
  }
};

/**
 * End of a foreground cycle: records Home's "last synced" when the cycle counts as synced (spec section 14,
 * R50), refreshes the banners, and ALWAYS invalidates Home, even when the banner refresh rejects. Given
 * `checkDuplicates` / `autoApply` it also runs `afterCycleBackground` inline (Home is read again when something
 * was answered); the app passes those to the runner's background step instead.
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
    quietly(d.invalidateHome);
    await afterCycleBackground(summary, {
      checkDuplicates: d.checkDuplicates,
      autoApply: d.autoApply,
      onDone: (n) => (n ? d.invalidateHome() : undefined),
    });
  }
}
