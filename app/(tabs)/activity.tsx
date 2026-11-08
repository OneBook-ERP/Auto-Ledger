import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import type { PendingTxn } from '../../src/core/types';
import { bringBack, pollStatuses } from '../../src/ingest/statusPoller';
import { undoTxn, type UndoResult } from '../../src/outbox/runner';
import { PAGE_SIZE, canPutBack, canUndo, docLines, docUrl, groupActivity, signedAmount, statusOf, titleOf } from '../../src/state/activityModel';
import { useApp } from '../../src/state/AppProvider';
import { useUiStore } from '../../src/state/store';
import { useErpOps } from '../../src/state/useErpOps';
import { ActivityRow, Banner, Button, EmptyState, Screen, SectionHeader, formatInr, type ActivityAction } from '../../src/ui';

export const UNDO_CONFIRM_TITLE = 'Undo this entry?';
export const UNDO_CONFIRM_MESSAGE = 'Remove the draft from ERPNext and put this message back in your Inbox?';
export const OFFLINE_MESSAGE = 'No connection. Nothing was removed yet.';

type Notice = { tone: 'ok' | 'warn' | 'error'; message: string; retry?: () => void };

export default function Activity() {
  const { repo } = useApp();
  const erp = useErpOps();
  const router = useRouter();
  const siteUrl = useUiStore((s) => s.session?.siteUrl ?? null);
  const [items, setItems] = useState<PendingTxn[] | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const alive = useRef(true);
  const busyRef = useRef<Set<string>>(new Set());
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const all = await repo.listPending();
    if (alive.current) setItems(all);
  }, [repo]);

  const refresh = useCallback(async () => {
    try {
      await load();
      if (erp) {
        await pollStatuses({ repo, erp, now: Date.now });
        await load();
      }
    } catch {
      // the list stays as it was
    }
  }, [load, erp, repo]);

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

  const showResult = (r: UndoResult, retry: () => void, doneMessage: string) => {
    if (r.status === 'undone') setNotice({ tone: 'ok', message: doneMessage });
    else if (r.status === 'refused') setNotice({ tone: 'warn', message: r.message });
    else if (r.status === 'needs_login') {
      useUiStore.getState().setNeedsLogin(true);
      setNotice(null);
      router.push('/(auth)/login');
    } else if (r.retryable) setNotice({ tone: 'error', message: OFFLINE_MESSAGE, retry });
    else setNotice({ tone: 'error', message: r.error.message });
  };

  const runUndo = (t: PendingTxn, putBack: boolean) =>
    guarded(t.id, async () => {
      setNotice(null);
      if (!erp && !(putBack && t.createdDocs.every((d) => d.docstatus === 2 || d.docstatus === -1))) {
        useUiStore.getState().setNeedsLogin(true);
        router.push('/(auth)/login');
        return;
      }
      const r = erp
        ? await undoTxn(t.id, { repo, erp }, { docsAlreadyGone: putBack })
        : await undoTxn(t.id, { repo, erp: NO_ERP }, { docsAlreadyGone: true });
      showResult(r, () => void runUndo(t, putBack), 'Put back in your Inbox.');
      await load();
    });

  const confirmUndo = (t: PendingTxn) =>
    Alert.alert(UNDO_CONFIRM_TITLE, UNDO_CONFIRM_MESSAGE, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Undo', style: 'destructive', onPress: () => void runUndo(t, false) },
    ]);

  const doBringBack = (t: PendingTxn) =>
    guarded(t.id, async () => {
      setNotice(null);
      const ok = await bringBack(t.id, { repo });
      setNotice(ok ? { tone: 'ok', message: 'Brought back to your Inbox.' } : { tone: 'warn', message: 'This entry changed, so it was not brought back.' });
      await load();
    });

  const actionsFor = (t: PendingTxn): ActivityAction[] => {
    const a: ActivityAction[] = [];
    if (canUndo(t)) a.push({ label: 'Undo', variant: 'danger', onPress: () => confirmUndo(t) });
    if (canPutBack(t)) a.push({ label: 'Put back in Inbox', onPress: () => void runUndo(t, true) });
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
        amount={signedAmount(t, formatInr)}
        date={t.occurredOn}
        docs={docLines(t.createdDocs)}
        status={{ label: s.label, tone: s.tone }}
        hint={s.hint}
        actions={actionsFor(t)}
        busy={busy.has(t.id)}
      />
    );
  };

  const g = groupActivity(items ?? [], limit);
  const section = (title: string, list: PendingTxn[]) =>
    list.length ? (
      <>
        <SectionHeader title={title} count={list.length} />
        {list.map(row)}
      </>
    ) : null;

  return (
    <Screen
      title="Activity"
      top={notice ? <Banner tone={notice.tone} message={notice.message} actionLabel={notice.retry ? 'Retry' : undefined} onAction={notice.retry} testID="activity-notice" /> : undefined}
      onRefresh={() => void pullToRefresh()}
      refreshing={refreshing}>
      {items && g.total === 0 ? (
        <EmptyState title="Nothing processed yet" message="Entries you create from the Inbox are listed here, with an option to undo each draft while it is still a draft." />
      ) : null}
      {section('Waiting for your accountant', g.created)}
      {section('Submitted', g.submitted)}
      {section('Ignored', g.ignored)}
      {g.total > g.shown ? <Button variant="secondary" label={`Show older (${g.total - g.shown} more)`} onPress={() => setLimit((n) => n + PAGE_SIZE)} /> : null}
    </Screen>
  );
}

// Put back in Inbox for entries whose documents are all recorded as gone needs no ERPNext call.
const NO_ERP = {
  getDocStatuses: async () => { throw new Error('offline'); },
  deleteDraft: async () => { throw new Error('offline'); },
} as unknown as Parameters<typeof undoTxn>[1]['erp'];
