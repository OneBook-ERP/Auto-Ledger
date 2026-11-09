import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { PendingTxn } from '../core/types';
import { useUiStore } from '../state/store';
import { fakeApp } from '../state/testUtils';
import { usePendingCount } from '../../app/(tabs)/_layout';
import { useInboxData } from './hooks';

jest.mock('expo-router', () => {
  const React = require('react');
  return { useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]), Tabs: () => null, Redirect: () => null };
});

const txn = (id: string, state: PendingTxn['state']): PendingTxn => ({
  id, mergedCount: 1, state, createdDocs: [], error: null, kind: 'ca_credit', direction: 'in', amountMinor: 100, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: null, accountType: 'bank', accountLast4: '3455', counterparty: id, utr: null, merchant: null,
  balanceMinor: null, sender: 'AX-IDFCFB', receivedAt: 1762300000000, rawHash: `h${id}`,
});

async function seeded() {
  const app = await fakeApp();
  for (const [i, s] of (['new', 'new', 'created', 'created', 'created', 'submitted'] as const).entries()) await app.repo.upsertPending(txn(`t${i}`, s));
  const listPending = jest.spyOn(app.repo, 'listPending');
  const countPending = jest.spyOn(app.repo, 'countPending');
  return { ...app, listPending, countPending };
}

it('the tab badge counts unanswered rows with COUNT, without listing them', async () => {
  const app = await seeded();
  const { result } = await renderHook(() => usePendingCount(), { wrapper: app.Wrap });
  await waitFor(() => expect(result.current).toBe(2));
  expect(app.countPending).toHaveBeenCalledWith('new');
  expect(app.listPending).not.toHaveBeenCalled();
});

it('the Inbox model gets the draft count from COUNT and lists only unanswered rows', async () => {
  const app = await seeded();
  const { result } = await renderHook(() => useInboxData(), { wrapper: app.Wrap });
  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(result.current.model).not.toBeNull());
  expect(result.current.model?.trustLine).toContain('3 drafts');
  expect(app.listPending.mock.calls).toEqual([['new']]);
  expect(app.countPending).toHaveBeenCalledWith('created');
});

it('the Inbox re-reads after a cycle or its automatic answers (data version bumped), not before', async () => {
  const app = await seeded();
  const { result } = await renderHook(() => useInboxData(), { wrapper: app.Wrap });
  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(result.current.model?.countLabel).toBe('2 to answer'));
  await app.repo.upsertPending(txn('t0', 'created')); // answered automatically in the background
  await act(async () => { useUiStore.getState().bumpData(); });
  await waitFor(() => expect(result.current.model?.countLabel).toBe('1 to answer'));
});
