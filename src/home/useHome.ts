// Home data: local rows (mappings, drafts, settings) + ERPNext figures, both under site-keyed query keys.
import { useFocusEffect } from 'expo-router';
import { focusManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AccountMapping, PendingTxn } from '../core/types';
import { getBankBalance, getReceivablesPayables } from '../erp/docs';
import { ErpAuthError, type ErpClient } from '../erp/client';
import { useApp } from '../state/AppProvider';
import { COMPANY_KEY } from '../state/useSetting';
import { useUiStore } from '../state/store';
import { buildHomeModel, HOME_CACHE_KEY, LAST_SYNCED_KEY, parseHomeCache, serializeHomeCache, type HomeFigures, type HomeModel } from './viewModel';

type Local = { mappings: AccountMapping[]; pending: PendingTxn[]; lastSyncedAt: number | null; company: string | null };
export type AuthProblem = { status: number; deniedDoctype?: string };
type Fetched = { figures: HomeFigures; at: number; stale: boolean; auth: AuthProblem | null };

export const homeKey = (siteUrl: string | null) => ['home', siteUrl] as const;

/** Fetches the figures; when ERPNext cannot be reached falls back to the saved copy, marked stale. */
export async function loadFigures(args: {
  client: ErpClient | null;
  siteUrl: string;
  company: string;
  mappings: AccountMapping[];
  getCache(): Promise<string | null>;
  saveCache(v: string): Promise<void>;
  now(): number;
}): Promise<Fetched> {
  try {
    if (!args.client) throw new Error('Not signed in');
    const c = args.client;
    const banks = args.mappings.filter((m) => m.kind === 'bank');
    const [amounts, rp] = await Promise.all([
      Promise.all(banks.map((m) => getBankBalance(c, m.glAccount, args.company))),
      getReceivablesPayables(c, args.company),
    ]);
    const balances: Record<string, number> = {};
    banks.forEach((m, i) => (balances[m.glAccount] = amounts[i]));
    const at = args.now();
    try {
      await args.saveCache(serializeHomeCache({ at, site: args.siteUrl, balances, receivableMinor: rp.receivableMinor, payableMinor: rp.payableMinor }));
    } catch {
      // the cache is a convenience
    }
    return { figures: { balances, receivableMinor: rp.receivableMinor, payableMinor: rp.payableMinor }, at, stale: false, auth: null };
  } catch (e) {
    let cache = null;
    try {
      cache = parseHomeCache(await args.getCache(), args.siteUrl);
    } catch {
      cache = null;
    }
    if (!cache) throw e;
    return {
      figures: { balances: cache.balances, receivableMinor: cache.receivableMinor, payableMinor: cache.payableMinor },
      at: cache.at,
      stale: true,
      auth: e instanceof ErpAuthError ? { status: e.status, deniedDoctype: e.deniedDoctype } : null,
    };
  }
}

export type HomeState = {
  status: 'loading' | 'ready' | 'error';
  model: HomeModel | null;
  company: string | null;
  /** Set when ERPNext answered 401 (sign-in expired) or 403 (no permission). */
  auth: AuthProblem | null;
  refreshing: boolean;
  refresh(): Promise<void>;
  retry(): void;
};

/** `now` and `tickMs` are test seams: the clock is re-read on every refetch, foreground return and tick. */
export function useHome(now: () => number = Date.now, tickMs = 60_000): HomeState {
  const { repo, client, runCycle } = useApp();
  const siteUrl = useUiStore((s) => s.session?.siteUrl ?? null);
  const qc = useQueryClient();
  const [pulling, setPulling] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), tickMs);
    const unsub = focusManager.subscribe((focused) => focused && setTick((t) => t + 1));
    return () => {
      clearInterval(id);
      unsub();
    };
  }, [tickMs]);

  const local = useQuery({
    queryKey: [...homeKey(siteUrl), 'local'],
    enabled: siteUrl !== null,
    staleTime: 0,
    queryFn: async (): Promise<Local> => {
      const [mappings, pending, synced, company] = await Promise.all([repo.listMappings(), repo.listPending(), repo.getSetting(LAST_SYNCED_KEY), repo.getSetting(COMPANY_KEY)]);
      const n = synced ? Number(synced) : NaN;
      return { mappings, pending, lastSyncedAt: Number.isFinite(n) ? n : null, company };
    },
  });
  const l = local.data;
  const glKey = (l?.mappings ?? []).filter((m) => m.kind === 'bank').map((m) => m.glAccount).join('|');
  const figures = useQuery({
    queryKey: [...homeKey(siteUrl), 'figures', l?.company ?? null, glKey],
    enabled: siteUrl !== null && !!l && !!l.company,
    staleTime: 0,
    retry: false,
    queryFn: () =>
      loadFigures({
        client,
        siteUrl: siteUrl as string,
        company: (l as Local).company as string,
        mappings: (l as Local).mappings,
        getCache: () => repo.getSetting(HOME_CACHE_KEY),
        saveCache: (v) => repo.setSetting(HOME_CACHE_KEY, v),
        now,
      }),
  });

  // Coming back to the tab (e.g. after answering messages in the Inbox) re-reads everything.
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) {
        first.current = false;
        return;
      }
      void qc.invalidateQueries({ queryKey: homeKey(siteUrl) });
    }, [qc, siteUrl]),
  );

  const refresh = useCallback(async () => {
    setPulling(true);
    try {
      await runCycle();
      await qc.invalidateQueries({ queryKey: homeKey(siteUrl) });
    } finally {
      setPulling(false);
    }
  }, [qc, runCycle, siteUrl]);

  const f = figures.data;
  // A failed refetch keeps the earlier data: say so instead of presenting it as fresh.
  const refetchFailed = figures.isError && !!f;
  const model = useMemo(
    () =>
      l
        ? buildHomeModel({
            mappings: l.mappings,
            pending: l.pending,
            figures: f?.figures ?? null,
            figuresAt: f?.at ?? null,
            figuresStale: (f?.stale ?? false) || refetchFailed,
            lastSyncedAt: l.lastSyncedAt,
            now: now(),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [l, f, refetchFailed, tick],
  );

  const loading = local.isPending || (!!l?.company && figures.isPending && !figures.isError);
  const failed = local.isError || (figures.isError && !f);
  return {
    status: failed ? 'error' : loading || !model ? 'loading' : 'ready',
    model: failed ? null : model,
    company: l?.company ?? null,
    auth: f?.auth ?? (figures.error instanceof ErpAuthError ? { status: figures.error.status, deniedDoctype: figures.error.deniedDoctype } : null),
    refreshing: pulling,
    refresh,
    retry: () => void qc.invalidateQueries({ queryKey: homeKey(siteUrl) }),
  };
}
