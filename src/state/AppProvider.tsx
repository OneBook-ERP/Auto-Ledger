// App wiring: the single Repo, the stored Session, ErpClient/ErpOps, the foreground cycle, template refresh
// and the banners. Nothing runs at import time; everything starts from effects.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Text, View } from 'react-native';
import type { Session } from '../erp/auth';
import type { ErpClient } from '../erp/client';
import type { Repo, SqlDriver } from '../data/repo';
import { NEEDS_LOGIN_SINCE_KEY } from '../ingest/drain';
import { runForegroundCycle, type CycleSummary } from '../ingest/pipeline';
import { getAppRepo } from './appRepo';
import { TEMPLATES_URL } from './config';
import { attachAppStateCycle, createCycleRunner } from './cycle';
import { buildErp } from './erp';
import { getNative, type SmsNative } from './native';
import { clearSession, persistSession, restoreSession, summarize } from './session';
import { useUiStore } from './store';
import { maybeRefreshTemplates } from './templatesSchedule';

export const SETUP_DONE_KEY = 'setupDone';
export const SITE_URL_KEY = 'site_url';

export type AppContextValue = {
  repo: Repo;
  native: SmsNative;
  /** Null while signed out. */
  client: ErpClient | null;
  /** Stores the new session (without roles), clears the "sign in again" flag and runs a cycle. */
  signIn(s: Session): Promise<void>;
  /** Forgets the credentials. Local data (mappings, pending items) is kept. */
  signOut(): Promise<void>;
  /** Marks setup finished and runs one foreground cycle. */
  completeSetup(): Promise<void>;
  runCycle(): Promise<void>;
};

const Ctx = createContext<AppContextValue | null>(null);
/** Exported so tests can supply a fake app. */
export const AppContext = Ctx;

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used inside AppProvider');
  return v;
}

export type AppProviderProps = {
  children: ReactNode;
  /** Test seams. */
  openDriver?: () => Promise<SqlDriver>;
  native?: SmsNative;
  fetchImpl?: typeof fetch;
  now?: () => number;
  templatesUrl?: string;
};

export function AppProvider({ children, openDriver, native: nativeProp, fetchImpl, now = Date.now, templatesUrl = TEMPLATES_URL }: AppProviderProps) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000 } } }));
  const [repo, setRepo] = useState<Repo | null>(null);
  const [failed, setFailed] = useState(false);
  const [full, setFull] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const repoRef = useRef<Repo | null>(null);
  const started = useRef(false);
  const native = useMemo(() => nativeProp ?? getNative(), [nativeProp]);
  const setBoot = useUiStore((s) => s.setBoot);
  const ready = useUiStore((s) => s.boot === 'ready');
  const signedIn = useUiStore((s) => s.session !== null);
  const setupDone = useUiStore((s) => s.setupDone);

  // Boot: open the one Repo, read the saved session and the setup flag.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await getAppRepo(openDriver);
        let session: Session | null = null;
        try {
          session = await restoreSession();
        } catch {
          session = null;
        }
        const done = (await r.getSetting(SETUP_DONE_KEY)) === '1';
        if (!live) return;
        repoRef.current = r;
        sessionRef.current = session;
        setRepo(r);
        setFull(session);
        setBoot({ session: session ? summarize(session) : null, setupDone: done });
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [openDriver, setBoot]);

  const refreshBanners = useCallback(async () => {
    const r = repoRef.current;
    if (!r) return;
    const ui = useUiStore.getState();
    ui.setNeedsLogin(!!(await r.getSetting(NEEDS_LOGIN_SINCE_KEY)));
    try {
      ui.setEngineUnusable((await native.engineHealth()).usable === false);
    } catch {
      // keep the previous value
    }
  }, [native]);

  const runner = useMemo(
    () =>
      createCycleRunner({
        run: async (): Promise<CycleSummary> => {
          const r = repoRef.current;
          const s = sessionRef.current;
          if (!r || !s) return { failedSteps: [] };
          const { erp } = buildErp(s, { fetchImpl });
          return runForegroundCycle({ repo: r, native, erp, now, fetchImpl });
        },
        after: refreshBanners,
      }),
    [native, fetchImpl, now, refreshBanners],
  );

  const startCycle = useCallback(() => {
    started.current = true;
    return runner.trigger();
  }, [runner]);

  // App start (after the gate) and every return to the foreground. Template refresh rides on the start.
  useEffect(() => {
    if (!ready || !signedIn || !setupDone) return;
    const detach = attachAppStateCycle(runner, AppState);
    if (!started.current) {
      void startCycle();
      const r = repoRef.current;
      if (r) void maybeRefreshTemplates({ url: templatesUrl, repo: r, native, now, fetchImpl });
    }
    return detach;
  }, [ready, signedIn, setupDone, runner, startCycle, native, templatesUrl, now, fetchImpl]);

  const client = useMemo(() => (full ? buildErp(full, { fetchImpl }).client : null), [full, fetchImpl]);

  const value = useMemo<AppContextValue | null>(() => {
    if (!repo) return null;
    return {
      repo,
      native,
      client,
      async signIn(s) {
        await persistSession(s);
        sessionRef.current = s;
        // A different site means the saved accounts belong to another books file: the wizard must run again.
        const prevSite = await repo.getSetting(SITE_URL_KEY);
        if (prevSite && prevSite !== s.siteUrl) {
          await repo.setSetting(SETUP_DONE_KEY, '0');
          useUiStore.getState().setSetupDone(false);
        }
        await repo.setSetting(SITE_URL_KEY, s.siteUrl);
        await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, '');
        useUiStore.getState().setNeedsLogin(false);
        setFull(s);
        useUiStore.getState().setSession(summarize(s));
        if (useUiStore.getState().setupDone) void startCycle();
      },
      async signOut() {
        await clearSession();
        sessionRef.current = null;
        setFull(null);
        started.current = false;
        useUiStore.getState().setSession(null);
        useUiStore.getState().setNeedsLogin(false);
      },
      async completeSetup() {
        await repo.setSetting(SETUP_DONE_KEY, '1');
        useUiStore.getState().setSetupDone(true);
        await startCycle();
      },
      runCycle: () => startCycle(),
    };
  }, [repo, native, client, startCycle]);

  if (failed) {
    return (
      <View className="flex-1 items-center justify-center bg-paper p-8 dark:bg-paper-dark">
        <Text className="text-center text-base text-ink dark:text-ink-dark">AutoLedger could not open its local data. Restart the app; if this keeps happening, reinstall it.</Text>
      </View>
    );
  }
  if (!value) return null;
  return (
    <QueryClientProvider client={queryClient}>
      <Ctx.Provider value={value}>{children}</Ctx.Provider>
    </QueryClientProvider>
  );
}
