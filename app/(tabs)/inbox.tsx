import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { unrecognisedAccountKey } from '../../src/ingest/pipeline';
import { useInboxDeps } from '../../src/inbox/deps';
import { useInboxData, useTapGuard } from '../../src/inbox/hooks';
import { useFlowStore } from '../../src/inbox/store';
import { Banner, EmptyState, Gap, Pill, RefreshScroll, Row, Screen, Stack, Txt, TxnRow } from '../../src/ui';

export const EMPTY_TITLE = 'No transactions to classify';

/**
 * Pending bank transactions, newest first. Reached by the tab and by the autoledger://inbox deep link: that
 * link is BROWSABLE, so this screen deliberately reads NO route parameters and acts on nothing it is given.
 */
export default function Inbox() {
  const router = useRouter();
  const { repo, runCycle } = useInboxDeps();
  const { model, reload } = useInboxData();
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
    </Screen>
  );
}
