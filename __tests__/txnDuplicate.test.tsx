// The detail screen's "may already be in ERPNext" warning (wave 3, WARN ONLY: nothing is blocked or disabled).
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Linking } from 'react-native';
import TransactionScreen from '../app/txn/[id]';
import type { PendingTxn } from '../src/core/types';
import { DUPLICATE_STRONG, DUPLICATE_TITLE, DUPLICATE_WEAK } from '../src/inbox/describe';
import { InboxDepsOverride } from '../src/inbox/deps';
import { fakeInboxErp } from '../src/inbox/fakeErp';
import { BANK, CARD, NOW, txnFrom } from '../src/inbox/testData';
import { dupKey } from '../src/ingest/dupCheck';
import { runPlan } from '../src/outbox/runner';
import { fakeApp } from '../src/state/testUtils';

const mockRouter = {
  push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissAll: jest.fn(), dismissTo: jest.fn(), canGoBack: jest.fn(() => true),
};
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    useFocusEffect: (cb: () => void) => useEffect(() => cb(), [cb]),
    Redirect: () => null,
    Stack: () => null,
  };
});
jest.mock('../src/state/native', () => ({ getNative: () => ({}) }));

const SITE = 'https://zp.example.app';

async function open(t: PendingTxn, flag?: string) {
  const { Wrap: AppWrap, repo } = await fakeApp();
  for (const m of [BANK, CARD]) await repo.saveMapping(m);
  await repo.upsertPending(t);
  for (const [k, v] of Object.entries({ company: 'ZP', drawingsAccount: 'Drawings - ZP', defaultExpenseAccount: 'Office Expenses - ZP' })) await repo.setSetting(k, v);
  if (flag !== undefined) await repo.setSetting(dupKey(t.id), flag);
  const deps = { erp: fakeInboxErp(), now: () => NOW, runPlan: jest.fn(runPlan), siteUrl: SITE };
  const Wrap = ({ children }: { children: ReactNode }) => (
    <AppWrap>
      <InboxDepsOverride.Provider value={deps}>{children}</InboxDepsOverride.Provider>
    </AppWrap>
  );
  mockParams = { id: t.id };
  const r = await render(<Wrap><TransactionScreen /></Wrap>);
  await screen.findByTestId('action-sheet');
  return r;
}

const flagOf = (strength: 'strong' | 'weak', doctype = 'Payment Entry', name = 'ACC-PAY-2026-00012') => JSON.stringify({ doctype, name, strength });

const allEnabled = () =>
  within(screen.getByTestId('action-sheet')).getAllByRole('button').every((b) => !b.props.accessibilityState?.disabled);

beforeEach(() => {
  Object.values(mockRouter).forEach((f) => f.mockClear());
  mockParams = {};
  jest.restoreAllMocks();
});

describe('possible duplicate warning on the detail screen', () => {
  it('a strong flag warns, links to the entry, and every answer still works', async () => {
    const t = txnFrom('idfc-006');
    const r = await open(t, flagOf('strong'));
    expect(await screen.findByText(DUPLICATE_TITLE)).toBeTruthy();
    expect(screen.getByText(DUPLICATE_STRONG)).toBeTruthy();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await fireEvent.press(screen.getByRole('button', { name: 'Open it in ERPNext' }));
    expect(openURL).toHaveBeenCalledWith(`${SITE}/app/payment-entry/ACC-PAY-2026-00012`);
    expect(allEnabled()).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Customer advance' }));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/party', params: { id: t.id } });
    await r.unmount();
  });

  it('a weak flag says the payment is a few days apart, nothing is disabled', async () => {
    const r = await open(txnFrom('idfc-034'), flagOf('weak', 'Journal Entry', 'JV-7'));
    expect(await screen.findByText(DUPLICATE_WEAK)).toBeTruthy();
    expect(screen.getByText(DUPLICATE_TITLE)).toBeTruthy();
    expect(screen.queryByText(DUPLICATE_STRONG)).toBeNull();
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await fireEvent.press(screen.getByRole('button', { name: 'Open it in ERPNext' }));
    expect(openURL).toHaveBeenCalledWith(`${SITE}/app/journal-entry/JV-7`);
    expect(allEnabled()).toBe(true);
    await fireEvent.press(screen.getByRole('button', { name: 'Expense' }));
    expect(mockRouter.push).toHaveBeenCalled();
    await r.unmount();
  });

  it('no flag, no banner', async () => {
    const r = await open(txnFrom('idfc-006'));
    expect(screen.queryByText(DUPLICATE_TITLE)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open it in ERPNext' })).toBeNull();
    await r.unmount();
  });

  it('an unreadable flag shows no banner', async () => {
    const r = await open(txnFrom('idfc-006'), 'not json');
    expect(screen.queryByText(DUPLICATE_TITLE)).toBeNull();
    await r.unmount();
  });
});
