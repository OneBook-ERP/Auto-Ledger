import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import type { PendingTxn } from '../../src/core/types';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { plainAmount, titleOf } from '../../src/inbox/format';
import { newestFirst } from '../../src/inbox/hooks';
import { erpDocUrl } from '../../src/inbox/outcome';
import { Button, DetailCard, Gap, Row, Screen, Stack, Txt, formatInr, openExternal } from '../../src/ui';

export const WAITING = 'Waiting for your accountant';

export default function ResultScreen() {
  const { id, inr } = useLocalSearchParams<{ id: string; inr?: string }>();
  const router = useRouter();
  const { repo, siteUrl } = useInboxDeps();
  const [data, setData] = useState<{ txn: PendingTxn | null; next: PendingTxn | null; left: number } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const txn = id ? await repo.getPending(id) : null;
      // "Next" skips answers already queued for sending (they are answered, only waiting for the network).
      const queued = new Set(await repo.listQueuedTxnIds());
      const rest = newestFirst((await repo.listPending('new')).filter((t) => t.id !== id && !queued.has(t.id)));
      if (live) setData({ txn, next: rest[0] ?? null, left: rest.length });
    })().catch(() => live && setData({ txn: null, next: null, left: 0 }));
    return () => {
      live = false;
    };
  }, [id, repo]);

  const toInbox = () => router.navigate('/(tabs)/inbox');
  if (!data) return <FlowLoading />;
  if (!data.txn) return <FlowGone onInbox={toInbox} />;
  const txn = data.txn;
  const ignored = txn.state === 'ignored';
  const who = txn.counterparty ?? txn.merchant;
  const docs = txn.createdDocs;

  const footer = (
    <Stack gap={2}>
      {data.next ? (
        <Button label={`Next: ${titleOf(data.next)}, ${data.left} left`} onPress={() => router.replace({ pathname: '/txn/[id]', params: { id: data.next!.id } })} />
      ) : (
        <Button label="Back to Inbox" onPress={toInbox} />
      )}
      <Row between>
        {!ignored && docs.length > 0 && siteUrl ? (
          <Button variant="quiet" label="Open in ERPNext" onPress={() => void openExternal(erpDocUrl(siteUrl, docs[docs.length - 1].doctype, docs[docs.length - 1].name))} />
        ) : null}
        {!ignored ? <Button variant="quiet" label="See it in Activity" onPress={() => router.navigate('/(tabs)/activity')} /> : null}
      </Row>
    </Stack>
  );

  if (ignored) {
    return (
      <Screen title="Message ignored" subtitle="Nothing was added to ERPNext." footer={footer}>
        <Txt variant="muted">It will not show up in your Inbox again.</Txt>
      </Screen>
    );
  }

  return (
    <Screen title={docs.length > 1 ? 'Drafts created' : 'Draft created'} footer={footer}>
      <Txt>{`${txn.currency !== 'INR' && inr && Number(inr) > 0 ? `${formatInr(Number(inr))} (${plainAmount(txn)})` : plainAmount(txn)}${who ? ` ${txn.direction === 'in' ? 'from' : 'to'} ${who}` : ''} is now in ERPNext as a draft.`}</Txt>
      <Gap size={4} />
      <DetailCard
        rows={[...docs.map((d) => ({ label: d.doctype, value: d.name, mono: true })), { label: 'Status', value: WAITING }]}
        testID="docs"
      />
      <Txt variant="muted">You can undo this in Activity until your accountant submits it.</Txt>
    </Screen>
  );
}
