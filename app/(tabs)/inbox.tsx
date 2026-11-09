import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useDeferredValue, useMemo, useState } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { unrecognisedAccountKey } from '../../src/ingest/pipeline';
import { useInboxDeps } from '../../src/inbox/deps';
import { useInboxData, useTapGuard } from '../../src/inbox/hooks';
import { useFlowStore } from '../../src/inbox/store';
import type { ActivityPeriod } from '../../src/state/activityModel';
import {
  Banner, Chip, DEFAULT_FILTERS, EmptyState, FilterSheet, Gap, Icon, Pill, RefreshScroll, Row, Screen, SearchField, Stack, Txt, TxnRow, activeFilterCount,
  type ActivityFilters,
} from '../../src/ui';

export const EMPTY_TITLE = 'No transactions to classify';
export const NO_MATCH_MESSAGE = 'Nothing matches. Try a different search or period.';
const PERIODS: { key: ActivityPeriod; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_fy', label: 'This financial year' },
  { key: 'all', label: 'All time' },
];

/**
 * Pending bank transactions, newest first. Reached by the tab and by the autoledger://inbox deep link: that
 * link is BROWSABLE, so this screen deliberately reads NO route parameters and acts on nothing it is given.
 */
export default function Inbox() {
  const router = useRouter();
  const { repo, runCycle } = useInboxDeps();
  const [query, setQuery] = useState('');
  const [period, setPeriod] = useState<ActivityPeriod>('all');
  const [filters, setFilters] = useState<ActivityFilters>(DEFAULT_FILTERS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const dark = useColorScheme() === 'dark';
  // Typing stays responsive: the list follows the text a moment later.
  const deferredQuery = useDeferredValue(query);
  const filter = useMemo(
    () => ({ query: deferredQuery, period, direction: filters.direction, accountLast4: filters.accountLast4, kind: filters.kind }),
    [deferredQuery, period, filters.direction, filters.accountLast4, filters.kind],
  );
  const { model, reload } = useInboxData(filter);
  const flash = useFlowStore((s) => s.flash);
  const [refreshing, setRefreshing] = useState(false);
  const tap = useTapGuard();

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await runCycle();
    } catch {
      // the cycle never rejects by contract; a failure here only means nothing new was read
    } finally {
      await reload().catch(() => undefined);
      setRefreshing(false);
    }
  };

  const nFilters = activeFilterCount(filters);
  const filtersLabel = nFilters ? `Filters (${nFilters})` : 'Filters';

  const dismissAll = async (last4s: string[]) => {
    await Promise.all(last4s.map((l) => repo.deleteSetting(unrecognisedAccountKey(l))));
    await reload();
  };

  return (
    <Screen scroll={false}>
      <Row between>
        <Txt variant="title" header>Inbox</Txt>
        {model ? <Pill text={model.countLabel} tone="accent" testID="count" /> : null}
      </Row>
      {model ? <Txt variant="muted" testID="trust">{model.trustLine}</Txt> : null}
      <Gap size={4} />
      {model && !model.empty ? (
        <>
          <SearchField value={query} onChange={setQuery} placeholder="Search by name" testID="inbox-search" />
          <View className="flex-row flex-wrap items-center">
            <Pressable
              onPress={() => setSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={filtersLabel}
              className="mb-2 mr-3 min-h-[48px] flex-row items-center">
              <Icon name="filter" size={18} color={dark ? '#8EA6FF' : '#2447D1'} />
              <Text className="ml-2 text-base font-semibold text-accent dark:text-accent-dark">{filtersLabel}</Text>
            </Pressable>
            {PERIODS.map((p) => (
              <Chip key={p.key} label={p.label} selected={period === p.key} onPress={() => setPeriod(p.key)} />
            ))}
          </View>
        </>
      ) : null}
      <RefreshScroll refreshing={refreshing} onRefresh={onRefresh} testID="inbox-list">
        {flash ? <Banner tone="warn" message={flash} actionLabel="Dismiss" onAction={() => useFlowStore.getState().setFlash(null)} testID="flash" /> : null}
        {model?.unreadText ? (
          <Banner tone="warn" message={model.unreadText} actionLabel="Open Settings" onAction={() => router.navigate('/(tabs)/settings')} testID="unread" />
        ) : null}
        {model?.accountsNotice ? (
          <Banner
            compact tone="warn" message={model.accountsNotice.text}
            actionLabel="Open Settings" onAction={() => router.navigate('/(tabs)/settings')}
            secondaryLabel="Dismiss all" onSecondary={() => void dismissAll(model.accountsNotice?.last4s ?? [])}
            testID="unknown-accounts" />
        ) : null}
        {model?.empty ? (
          <EmptyState title={EMPTY_TITLE} message="When a bank message arrives, it shows up here with one question: what was this for? Pull down to check for new messages." />
        ) : null}
        {model?.noMatch ? <Text className="px-2 py-8 text-center text-base text-muted dark:text-muted-dark">{NO_MATCH_MESSAGE}</Text> : null}
        {model?.sections.map((s) => (
          <Stack key={s.title} gap={2}>
            <Txt variant="section" header>{s.title}</Txt>
            <Stack gap={1}>
              {s.rows.map((r) => (
                <TxnRow key={r.id} testID={`row-${r.id}`} {...r} onPress={() => tap(() => router.push({ pathname: '/txn/[id]', params: { id: r.id } }))} />
              ))}
            </Stack>
            <Gap size={3} />
          </Stack>
        ))}
      </RefreshScroll>
      <FilterSheet
        mode="inbox"
        visible={sheetOpen}
        value={filters}
        accounts={model?.accounts ?? []}
        onApply={(f) => { setFilters(f); setSheetOpen(false); }}
        onReset={() => { setFilters(DEFAULT_FILTERS); setSheetOpen(false); }}
        onClose={() => setSheetOpen(false)}
      />
    </Screen>
  );
}
