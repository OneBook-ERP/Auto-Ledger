import type { AppStateStatus } from 'react-native';
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
