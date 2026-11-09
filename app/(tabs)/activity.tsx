import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Linking, Pressable, Text, View, useColorScheme } from 'react-native';
import type { PendingTxn } from '../../src/core/types';
import type { PendingState } from '../../src/data/repo';
import { AUTO_DONE_PREFIX, parseAutoDone } from '../../src/ingest/autoApply';
import { NEEDS_LOGIN_SINCE_KEY } from '../../src/ingest/drain';
import { bringBack, pollStatuses } from '../../src/ingest/statusPoller';
import { undoTxn, type UndoResult } from '../../src/outbox/runner';
import {
  PAGE_SIZE, UNDO_CONFIRM_MESSAGE, autoChip, canPutBack, canUndo, confirmText, docUrl, filterActivity, groupByRecency, isoToday, removalPlan, sortActivity,
  statusOf, titleOf, totalsOf, waitingCount, type ActivityPeriod, type AutoMark,
} from '../../src/state/activityModel';
import { siteMatches, useApp } from '../../src/state/AppProvider';
import { useUiStore } from '../../src/state/store';
import { useErpOps } from '../../src/state/useErpOps';
import {
  ActivityRow, Banner, Button, Chip, DEFAULT_FILTERS, EmptyState, Figure, FilterSheet, Icon, Screen, SearchField, SectionHeader, formatDate, formatInr, friendlyDoctype, signedMoney,
  activeFilterCount, type ActivityAction, type ActivityFilters,
} from '../../src/ui';

export { UNDO_CONFIRM_MESSAGE };
export const OFFLINE_MESSAGE = 'No connection. Nothing was removed yet.';
export const OFFLINE_PUT_BACK_MESSAGE = 'No connection. Nothing was changed.';
const SITE_CHANGED_MESSAGE = 'You are signed in to a different ERPNext site than this phone\'s data belongs to. Sign in again to the original site first.';

export const NO_MATCH_MESSAGE = 'Nothing matches. Try a different search or period.';
const PERIODS: { key: ActivityPeriod; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_fy', label: 'This financial year' },
  { key: 'all', label: 'All time' },
];

const ACTIVITY_STATES: PendingState[] = ['created', 'submitted', 'ignored'];

type Notice = { tone: 'ok' | 'warn' | 'error'; message: string; retry?: () => void };

export default function Activity() {
  const { repo } = useApp();
  const erp = useErpOps();
  const router = useRouter();
  const siteUrl = useUiStore((s) => s.session?.siteUrl ?? null);
  const [items, setItems] = useState<PendingTxn[] | null>(null);
  const [autoMarks, setAutoMarks] = useState<ReadonlyMap<string, AutoMark>>(new Map());
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<ActivityPeriod>('all');
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const dark = useColorScheme() === 'dark';
  const alive = useRef(true);
  const busyRef = useRef<Set<string>>(new Set());
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    // Unanswered rows are not shown here: never read (or parse) them.
    const [all, auto] = await Promise.all([repo.listPending(ACTIVITY_STATES), repo.listSettings(AUTO_DONE_PREFIX).catch(() => [])]);
    if (!alive.current) return;
    setItems(all);
    const marks = new Map<string, AutoMark>();
    for (const a of auto) {
      const m = parseAutoDone(a.value);
      if (m) marks.set(a.key.slice(AUTO_DONE_PREFIX.length), m);
    }
    setAutoMarks(marks);
  }, [repo]);

  const refresh = useCallback(async () => {
    try {
      await load();
      // Same guard as the foreground cycle: never ask a different site about this site's documents.
      if (erp && siteUrl && (await siteMatches(repo, siteUrl))) {
        const r = await pollStatuses({ repo, erp, now: Date.now });
        if (r.needsLogin) useUiStore.getState().setNeedsLogin(true);
        await load();
      }
    } catch {
      // the list stays as it was
    }
  }, [load, erp, repo, siteUrl]);

  // The Activity tab gained focus: show what is stored, then ask ERPNext what the accountant did.
  useFocusEffect(useCallback(() => { void refresh(); }, [refresh]));

  const pullToRefresh = async () => {
    setRefreshing(true);
    await refresh();
    if (alive.current) setRefreshing(false);
  };

  // One action per row at a time (double-taps and Undo vs. Put back are serialised).
  const guarded = async (id: string, fn: () => Promise<void>) => {
    if (busyRef.current.has(id)) return;
    busyRef.current = new Set(busyRef.current).add(id);
    setBusy(busyRef.current);
    try {
      await fn();
    } finally {
      const next = new Set(busyRef.current);
      next.delete(id);
      busyRef.current = next;
      if (alive.current) setBusy(next);
    }
  };

  const goLogin = async () => {
    try {
      if (!(await repo.getSetting(NEEDS_LOGIN_SINCE_KEY))) await repo.setSetting(NEEDS_LOGIN_SINCE_KEY, String(Date.now()));
    } catch {
      // the banner flag below is enough for this session
    }
    useUiStore.getState().setNeedsLogin(true);
    setNotice(null);
    router.push('/(auth)/login');
  };

  const showResult = async (r: UndoResult, retry: () => void, putBack: boolean) => {
    if (r.status === 'undone') {
      const n = r.kept?.length ?? 0;
      setNotice({
        tone: 'ok',
        message: n ? `Put back in your Inbox. ${r.kept!.map((d) => d.name).join(', ')} stays in ERPNext.` : 'Put back in your Inbox.',
      });
    } else if (r.status === 'refused') setNotice({ tone: 'warn', message: r.message });
    else if (r.status === 'needs_login') await goLogin();
    else if (r.retryable) setNotice({ tone: 'error', message: putBack ? OFFLINE_PUT_BACK_MESSAGE : OFFLINE_MESSAGE, retry });
    else setNotice({ tone: 'error', message: r.error.message });
  };

  // Undo and Put back in Inbox both re-read every document's status from ERPNext first.
  const runUndo = (t: PendingTxn, putBack: boolean) =>
    guarded(t.id, async () => {
      setNotice(null);
      if (!erp) {
        await goLogin();
        return;
      }
      if (!siteUrl || !(await siteMatches(repo, siteUrl))) {
        setNotice({ tone: 'error', message: SITE_CHANGED_MESSAGE });
        return;
      }
      const r = await undoTxn(t.id, { repo, erp }, { docsAlreadyGone: putBack });
      await showResult(r, () => void runUndo(t, putBack), putBack);
      await load();
    });

  // The dialog is open: no second tap may open another or start the action behind it.
  const confirming = useRef<Set<string>>(new Set());
  const confirmThen = async (t: PendingTxn, putBack: boolean) => {
    if (busyRef.current.has(t.id) || confirming.current.has(t.id)) return;
    confirming.current.add(t.id);
    // Documents can also be held by unanswered or failed rows (a partial failure keeps them), which the lean list
    // does not load: read everything once, only now that the user asked.
    let all: PendingTxn[];
    try {
      all = await repo.listPending();
    } catch {
      all = items ?? [];
    }
    const plan = removalPlan(t, all);
    const text = confirmText(plan);
    if (!text || (putBack && !plan.remove.length)) {
      confirming.current.delete(t.id);
      void runUndo(t, putBack);
      return;
    }
    const release = () => confirming.current.delete(t.id);
    Alert.alert(
      text.title,
      text.message,
      [
        { text: 'Cancel', style: 'cancel', onPress: release },
        { text: putBack ? 'Put back' : 'Undo', style: 'destructive', onPress: () => { release(); void runUndo(t, putBack); } },
      ],
      { cancelable: true, onDismiss: release },
    );
  };

  const doBringBack = (t: PendingTxn) =>
    guarded(t.id, async () => {
      setNotice(null);
      const ok = await bringBack(t.id, { repo });
      setNotice(ok ? { tone: 'ok', message: 'Brought back to your Inbox.' } : { tone: 'warn', message: 'This entry changed, so it was not brought back.' });
      await load();
    });

  const actionsFor = (t: PendingTxn): ActivityAction[] => {
    const a: ActivityAction[] = [];
    if (canUndo(t)) a.push({ label: 'Undo', variant: 'danger', onPress: () => void confirmThen(t, false) });
    if (canPutBack(t)) a.push({ label: 'Put back in Inbox', onPress: () => void confirmThen(t, true) });
    if (t.state === 'ignored') a.push({ label: 'Bring back', onPress: () => void doBringBack(t) });
    if (siteUrl && (t.state === 'created' || t.state === 'submitted')) {
      const open = t.createdDocs.filter((d) => d.docstatus !== -1);
      for (const d of open) {
        a.push({
          label: open.length > 1 ? `Open ${d.name} in ERPNext` : 'Open in ERPNext',
          variant: 'quiet',
          onPress: () => void Linking.openURL(docUrl(siteUrl, d)).catch(() => setNotice({ tone: 'error', message: 'Could not open ERPNext.' })),
        });
      }
    }
    return a;
  };

  const row = (t: PendingTxn) => {
    const s = statusOf(t);
    return (
      <ActivityRow
        key={t.id}
        testID={`activity-row-${t.id}`}
        title={titleOf(t)}
        amount={signedMoney(t.amountMinor, t.currency, t.direction)}
        direction={t.direction}
        date={formatDate(t.occurredOn)}
        docs={t.createdDocs.map((d) => ({ kind: friendlyDoctype(d.doctype), id: d.name }))}
        status={{ label: s.label, tone: s.tone }}
        badge={autoChip(t, autoMarks)}
        hint={s.hint}
        actions={actionsFor(t)}
        busy={busy.has(t.id)}
      />
    );
  };

  const today = isoToday(Date.now());
  // Re-derived only when the data, the search or the filters change, not on every busy/notice/sheet render.
  const derived = useMemo(() => {
    const processed = (items ?? []).filter((t) => t.state === 'created' || t.state === 'submitted' || t.state === 'ignored');
    const accounts = [...new Set(processed.map((t) => t.accountLast4).filter((x): x is string => !!x))].sort();
    const baseFilter = { query, period, direction: filters.direction, accountLast4: accounts.length > 1 ? filters.accountLast4 : undefined };
    const waiting = waitingCount(processed, baseFilter, today);
    const matching = sortActivity(filterActivity(processed, { ...baseFilter, status: filters.status }, today), filters.sort);
    return { processed, accounts, waiting, matching, totals: totalsOf(matching) };
  }, [items, query, period, filters, today]);
  const { processed, accounts, waiting, matching, totals } = derived;
  const shown = useMemo(() => matching.slice(0, limit), [matching, limit]);
  // Headings by recency only make sense newest first; any other order is one plain list.
  const groups = useMemo(
    () => (filters.sort === 'newest' ? groupByRecency(shown, today) : [{ title: null, rows: shown }]),
    [shown, filters.sort, today],
  );
  const nFilters = activeFilterCount(filters);
  const filtersLabel = nFilters ? `Filters (${nFilters})` : 'Filters';

  return (
    <Screen
      title="Activity"
      top={notice ? <Banner tone={notice.tone} message={notice.message} actionLabel={notice.retry ? 'Retry' : undefined} onAction={notice.retry} testID="activity-notice" /> : undefined}
      onRefresh={() => void pullToRefresh()}
      refreshing={refreshing}>
      {items && processed.length === 0 ? (
        <EmptyState title="Nothing processed yet" message="Entries you create from the Inbox are listed here, with an option to undo each draft while it is still a draft." />
      ) : null}
      {processed.length ? (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Search by name or reference" testID="activity-search" />
          <Pressable
            onPress={() => setSheetOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={filtersLabel}
            className="mb-2 min-h-[48px] flex-row items-center self-start">
            <Icon name="filter" size={18} color={dark ? '#8EA6FF' : '#2447D1'} />
            <Text className="ml-2 text-base font-semibold text-accent dark:text-accent-dark">{filtersLabel}</Text>
          </Pressable>
          <View className="flex-row flex-wrap">
            {PERIODS.map((p) => (
              <Chip key={p.key} label={p.label} selected={period === p.key} onPress={() => setPeriod(p.key)} />
            ))}
          </View>
          <View testID="activity-totals" className="mb-2 mt-1 flex-row justify-between rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
            <Figure size="md" label="Money in" value={formatInr(totals.inMinor)} />
            <Figure size="md" label="Money out" value={formatInr(totals.outMinor)} />
            <Figure size="md" label="Net" value={formatInr(totals.netMinor)} />
          </View>
          {waiting && filters.status !== 'waiting' ? (
            <Pressable
              onPress={() => setFilters({ ...filters, status: 'waiting' })} // only the status; period and search stay as they are
              accessibilityRole="button"
              accessibilityLabel={`${waiting} waiting for your accountant`}
              className="mb-1 min-h-[48px] justify-center self-start">
              <Text className="text-base font-semibold text-accent dark:text-accent-dark">{waiting} waiting for your accountant</Text>
            </Pressable>
          ) : null}
          {totals.foreignCount ? (
            <Text className="mb-1 text-sm text-muted dark:text-muted-dark">
              {totals.foreignCount === 1 ? '1 entry in another currency is not counted.' : `${totals.foreignCount} entries in another currency are not counted.`}
            </Text>
          ) : null}
          {matching.length === 0 ? <Text className="px-2 py-8 text-center text-base text-muted dark:text-muted-dark">{NO_MATCH_MESSAGE}</Text> : null}
        </>
      ) : null}
      {groups.map((g) => (
        <View key={g.title ?? 'all'}>
          {g.title ? <SectionHeader title={g.title} count={g.rows.length} /> : null}
          {g.rows.map(row)}
        </View>
      ))}
      {matching.length > shown.length ? (
        <Button variant="secondary" label={`Show older (${matching.length - shown.length} more)`} onPress={() => setLimit((n) => n + PAGE_SIZE)} />
      ) : null}
      <FilterSheet
        visible={sheetOpen}
        value={filters}
        accounts={accounts}
        onApply={(f) => { setFilters(f); setSheetOpen(false); }}
        onReset={() => { setFilters(DEFAULT_FILTERS); setSheetOpen(false); }}
        onClose={() => setSheetOpen(false)}
      />
    </Screen>
  );
}
