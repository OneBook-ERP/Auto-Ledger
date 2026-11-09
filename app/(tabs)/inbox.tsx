import { useFocusEffect, useRouter } from 'expo-router';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View, useColorScheme } from 'react-native';
import { AUTO_NEW_COUNT_KEY } from '../../src/ingest/autoApply';
import { unrecognisedAccountKey } from '../../src/ingest/pipeline';
import { useInboxDeps } from '../../src/inbox/deps';
import { useInboxData, useTapGuard } from '../../src/inbox/hooks';
import { pageItems, type InboxItem, type InboxRow } from '../../src/inbox/model';
import { useFlowStore } from '../../src/inbox/store';
import type { ChipView } from '../../src/inbox/suggestions';
import type { ActivityPeriod } from '../../src/state/activityModel';
import {
  Banner, Button, Chip, DEFAULT_FILTERS, EmptyState, FilterSheet, Gap, GroupCard, Icon, Pill, RefreshList, Row, Screen, SearchField, Txt, TxnRow, activeFilterCount,
  type ActivityFilters,
} from '../../src/ui';

const NO_CHIP: ChipView = { text: 'Who is this?', tone: 'plain' };
export const EMPTY_TITLE = 'No transactions to classify';
/** Rows shown at first and added each time the end of the list is reached. */
export const PAGE_ROWS = 50;
export const NO_MATCH_MESSAGE = 'Nothing matches. Try a different search or period.';
/** Group cards shown before "Show more groups". */
export const GROUPS_SHOWN = 3;
const PERIODS: { key: ActivityPeriod; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'this_fy', label: 'This financial year' },
  { key: 'all', label: 'All time' },
];

type ItemProps = { row: InboxRow; chip: ChipView; onOpen: (id: string) => void };
// A row redraws only when what it shows changes, not when the list is rebuilt after answering another item.
const InboxItemRow = memo(
  function InboxItemRow({ row, chip, onOpen }: ItemProps) {
    return <TxnRow testID={`row-${row.id}`} {...row} chip={chip} onPress={() => onOpen(row.id)} />;
  },
  (a, b) =>
    a.onOpen === b.onOpen && a.chip.text === b.chip.text && a.chip.tone === b.chip.tone && a.row.id === b.row.id && a.row.title === b.row.title &&
    a.row.subtitle === b.row.subtitle && a.row.amountText === b.row.amountText && a.row.kindIcon === b.row.kindIcon,
);

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

  const [rowLimit, setRowLimit] = useState(PAGE_ROWS);
  useEffect(() => setRowLimit(PAGE_ROWS), [filter]);
  const items = useMemo<InboxItem[]>(() => (model ? pageItems(model.sections, rowLimit) : []), [model, rowLimit]);
  const open = useCallback((id: string) => tap(() => router.push({ pathname: '/txn/[id]', params: { id } })), [tap, router]);
  const [allGroups, setAllGroups] = useState(false);
  const groups = model?.groups ?? [];
  const shownGroups = allGroups ? groups : groups.slice(0, GROUPS_SHOWN);
  // The bulk screen shows the same items as the card: same pattern, same search and filters.
  const openGroup = (key: string) => tap(() => router.push({ pathname: '/txn/bulk', params: { key, filter: JSON.stringify(filter) } }));
  const nFilters = activeFilterCount(filters);
  const filtersLabel = nFilters ? `Filters (${nFilters})` : 'Filters';

  const [hideAutoFailed, setHideAutoFailed] = useState(false);
  const autoFailed = model?.autoFailed ?? [];
  const seenAuto = async (then?: () => void) => {
    try {
      await repo.setSetting(AUTO_NEW_COUNT_KEY, '0');
    } catch {
      // the notice may come back once; nothing else depends on it
    }
    then?.();
    await reload().catch(() => undefined);
  };

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
      <RefreshList
        testID="inbox-list"
        data={items}
        keyExtractor={(x) => x.key}
        renderItem={({ item }) =>
          item.type === 'header' ? (
            <View className="pt-1"><Txt variant="section" header>{item.title}</Txt></View>
          ) : (
            <InboxItemRow row={item.row} chip={model?.chipOf(item.row.id) ?? NO_CHIP} onOpen={open} />
          )
        }
        refreshing={refreshing}
        onRefresh={onRefresh}
        onEndReached={() => setRowLimit((n) => (model && n < model.rows.length ? n + PAGE_ROWS : n))}
        header={
          <View>
            {flash ? <Banner tone="warn" message={flash} actionLabel="Dismiss" onAction={() => useFlowStore.getState().setFlash(null)} testID="flash" /> : null}
            {model?.autoDoneText ? (
              <Banner
                tone="ok" message={model.autoDoneText}
                actionLabel="See Activity" onAction={() => void seenAuto(() => router.navigate('/(tabs)/activity'))}
                secondaryLabel="Dismiss" onSecondary={() => void seenAuto()}
                testID="auto-done" />
            ) : null}
            {autoFailed.length && !hideAutoFailed ? (
              <Banner
                tone="warn"
                title={autoFailed.length === 1 ? '1 payment was not done automatically' : `${autoFailed.length} payments were not done automatically`}
                message={[
                  ...autoFailed.slice(0, 3).map((f) => f.text),
                  autoFailed.length > 3 ? `And ${autoFailed.length - 3} more, marked in the list.` : '',
                  'They wait here. Open each one to answer it.',
                ].filter(Boolean).join('\n\n')}
                actionLabel="Dismiss" onAction={() => setHideAutoFailed(true)}
                testID="auto-failed" />
            ) : null}
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
            {shownGroups.length ? (
              <View testID="groups" className="pt-1">
                <Txt variant="section" header>Similar payments</Txt>
                <Gap size={2} />
                {shownGroups.map((g) => (
                  <GroupCard key={g.key} testID={`group-${g.key}`} title={g.title} answer={g.answer} onPress={() => openGroup(g.key)} />
                ))}
                {groups.length > GROUPS_SHOWN ? (
                  <Button
                    variant="quiet"
                    label={allGroups ? 'Show fewer groups' : `Show ${groups.length - GROUPS_SHOWN} more group${groups.length - GROUPS_SHOWN === 1 ? '' : 's'}`}
                    onPress={() => setAllGroups((v) => !v)}
                  />
                ) : null}
              </View>
            ) : null}
          </View>
        }
      />
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
