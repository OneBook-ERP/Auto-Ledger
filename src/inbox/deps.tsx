// Everything the Inbox screens talk to, from the app context by default. Tests override parts of it.
import { createContext, useContext, useMemo } from 'react';
import type { Repo } from '../data/repo';
import { runPlan } from '../outbox/runner';
import { useApp } from '../state/AppProvider';
import { useUiStore } from '../state/store';
import { makeInboxErp, type InboxErp } from './erp';

export type InboxDeps = {
  repo: Repo;
  /** Null while signed out. */
  erp: InboxErp | null;
  siteUrl: string;
  now: () => number;
  runPlan: typeof runPlan;
  /** The provider's single-flight foreground cycle. */
  runCycle: () => Promise<void>;
};

export const InboxDepsOverride = createContext<Partial<InboxDeps> | null>(null);

export function useInboxDeps(): InboxDeps {
  const app = useApp();
  const over = useContext(InboxDepsOverride);
  const siteUrl = useUiStore((s) => s.session?.siteUrl ?? '');
  const erp = useMemo(() => (app.client ? makeInboxErp(app.client) : null), [app.client]);
  return useMemo(
    () => ({ repo: app.repo, erp, siteUrl, now: Date.now, runPlan, runCycle: app.runCycle, ...over }),
    [app.repo, app.runCycle, erp, siteUrl, over],
  );
}
