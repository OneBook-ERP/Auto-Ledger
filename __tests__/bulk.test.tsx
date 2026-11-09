import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert } from 'react-native';
import Inbox from '../app/(tabs)/inbox';
import BulkScreen from '../app/txn/bulk';
import type { AccountMapping, PendingTxn, Rule } from '../src/core/types';
import { ErpValidationError } from '../src/erp/client';
import { InboxDepsOverride } from '../src/inbox/deps';
import { fakeInboxErp, type FakeInboxErp } from '../src/inbox/fakeErp';
import { useFlowStore } from '../src/inbox/store';
import { AUTO_NEW_COUNT_KEY, autoFailedKey } from '../src/ingest/autoApply';
import { dupKey } from '../src/ingest/dupCheck';
import { BANK, CARD, NOW, txnFrom } from '../src/inbox/testData';
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

const KEY = 'm:out:facebooksi';
const fb = (id: string, amountMinor: number, over: Partial<PendingTxn> = {}) =>
  txnFrom('idfc-035', { id, rawHash: `h-${id}`, amountMinor, receivedAt: 1_793_985_292_268 + amountMinor, ...over });
const ADS: Rule = { matchKey: KEY, action: 'expense', account: 'Advertising - ZP', hits: 2, lastUsed: 1, auto: false, maxAmountMinor: 100_000, currency: 'INR' };

async function setup(o: { txns?: PendingTxn[]; rules?: Rule[]; mappings?: AccountMapping[]; erp?: FakeInboxErp | null; settings?: Record<string, string> } = {}) {
  const { Wrap: AppWrap, repo } = await fakeApp();
  for (const m of o.mappings ?? [BANK, CARD]) await repo.saveMapping(m);
  for (const t of o.txns ?? []) await repo.upsertPending(t);
  for (const r of o.rules ?? []) await repo.saveRule(r);
  const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', ...o.settings };
  for (const [k, v] of Object.entries(settings)) if (v !== '') await repo.setSetting(k, v);
  const erp = o.erp === undefined ? fakeInboxErp() : o.erp;
  const deps = { erp, now: () => NOW, runPlan: jest.fn(runPlan), siteUrl: 'https://zp.example.app' };
  const Wrap = ({ children }: { children: ReactNode }) => (
    <AppWrap>
      <InboxDepsOverride.Provider value={deps}>{children}</InboxDepsOverride.Provider>
    </AppWrap>
  );
  return { repo, erp: erp as FakeInboxErp, Wrap };
}

const confirmWith = (label: string) =>
  jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.text === label)?.onPress?.());

beforeEach(() => {
  Object.values(mockRouter).forEach((f) => f.mockClear());
  mockParams = { key: KEY };
  useFlowStore.setState({ drafts: {}, flash: null });
  jest.restoreAllMocks();
});

describe('Inbox group cards', () => {
  it('shows one card for similar payments and opens the bulk screen with the same search and filters', async () => {
    const { Wrap } = await setup({ txns: [fb('a', 100_000), fb('b', 2_400_000), fb('c', 10_000_000), txnFrom('idfc-034')], rules: [ADS] });
    await render(<Wrap><Inbox /></Wrap>);
    const card = await screen.findByTestId(`group-${KEY}`);
    expect(within(card).getByText('3 payments to FACEBOOK SI, ₹1,25,000.00 in total')).toBeTruthy();
    expect(within(card).getByText('Suggested: Expense, Advertising')).toBeTruthy();
    await fireEvent.press(card);
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/txn/bulk',
      params: { key: KEY, filter: JSON.stringify({ query: '', period: 'all' }) },
    });
  });

  it('a pattern with no remembered answer asks what these were', async () => {
    const { Wrap } = await setup({ txns: [fb('a', 100), fb('b', 200)] });
    await render(<Wrap><Inbox /></Wrap>);
    expect(within(await screen.findByTestId(`group-${KEY}`)).getByText('Choose what these were')).toBeTruthy();
  });
});

describe('Inbox notices for automatic answers', () => {
  it('"3 payments were done automatically. See Activity" opens Activity; Dismiss hides it for good', async () => {
    const { Wrap, repo } = await setup();
    await repo.setSetting(AUTO_NEW_COUNT_KEY, '3');
    await render(<Wrap><Inbox /></Wrap>);
    const banner = await screen.findByTestId('auto-done');
    expect(banner).toHaveTextContent(/3 payments were done automatically\. See Activity\./);
    await fireEvent.press(within(banner).getByRole('button', { name: 'See Activity' }));
    await waitFor(() => expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/activity'));
    await waitFor(() => expect(screen.queryByTestId('auto-done')).toBeNull());
    expect(await repo.getSetting(AUTO_NEW_COUNT_KEY)).toBe('0');
  });

  it('a payment that could not be done automatically stays with its plain message and a marked row', async () => {
    const { Wrap, repo } = await setup({ txns: [fb('a', 50_000)] });
    await repo.setSetting(autoFailedKey('a'), 'An entry ACC-PAY-1 (Payment Entry) already exists for this reference.');
    await render(<Wrap><Inbox /></Wrap>);
    const banner = await screen.findByTestId('auto-failed');
    expect(banner).toHaveTextContent(/1 payment was not done automatically/);
    expect(banner).toHaveTextContent(/FACEBOOK SI, ₹500\.00: An entry already exists for this reference\./);
    expect(within(screen.getByTestId('row-a')).getByText('Not done automatically. Open it to answer.')).toBeTruthy();
    await fireEvent.press(within(banner).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('auto-failed')).toBeNull();
  });
});

describe('Bulk screen', () => {
  it('lists every item ticked, except one that may already be booked; shows the amount range of the ticked ones', async () => {
    const items = [fb('a', 2_000), fb('b', 50_000), fb('c', 1_200_000)];
    const { Wrap, repo } = await setup({ txns: items, rules: [ADS] });
    await repo.setSetting(dupKey('c'), JSON.stringify({ doctype: 'Journal Entry', name: 'JE-1', strength: 'strong', why: 'details' }));
    await render(<Wrap><BulkScreen /></Wrap>);
    await screen.findByTestId('item-a');
    expect(screen.getByTestId('item-a').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId('item-b').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId('item-c').props.accessibilityState).toMatchObject({ checked: false });
    expect(screen.getByTestId('bulk-dups')).toHaveTextContent(/1 payment may already be in ERPNext, so it is not ticked/);
    expect(screen.getByTestId('bulk-range')).toHaveTextContent(/^Amounts from ₹20\.00 to ₹500\.00/);
    expect(screen.getByTestId('bulk-answer')).toHaveTextContent('Expense, Advertising');
    expect(screen.getByRole('button', { name: 'Apply to 2' })).toBeTruthy();
    await fireEvent.press(screen.getByTestId('item-c'));
    expect(screen.getByTestId('bulk-range')).toHaveTextContent(/^Amounts from ₹20\.00 to ₹12,000\.00/);
    await fireEvent.press(screen.getByTestId('item-a'));
    expect(screen.getByRole('button', { name: 'Apply to 2' })).toBeTruthy();
  });

  it('Apply to N answers every ticked item, reports honestly, then asks to do it automatically (Yes saves auto)', async () => {
    const items = [fb('a', 2_000), fb('b', 50_000), fb('c', 150_000)];
    const erp = fakeInboxErp();
    let call = 0;
    erp.createDraft.mockImplementation(async () => {
      call++;
      if (call === 2) throw new ErpValidationError('An entry ACC-JV-2026-00009 (Journal Entry) already exists for this reference.', 417);
      return { name: `JE-${call}` };
    });
    const { Wrap, repo } = await setup({ txns: items, rules: [ADS], erp });
    const alert = confirmWith('Apply to 3');
    await render(<Wrap><BulkScreen /></Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Apply to 3' }));
    expect(alert).toHaveBeenCalledWith('Apply to 3 payments?', expect.stringContaining('3 drafts'), expect.anything(), expect.anything());
    const result = await screen.findByTestId('bulk-result');
    expect(result).toHaveTextContent(/2 done, 1 needs your attention$/);
    const failure = screen.getByTestId('failure-b');
    expect(failure).toHaveTextContent(/₹500\.00/);
    expect(failure).not.toHaveTextContent(/ACC-JV|Journal Entry/);
    expect(await repo.getPending('b')).toMatchObject({ state: 'new' });
    // The user's own bulk answer may raise the largest confirmed amount.
    expect((await repo.listRules()).find((r) => r.matchKey === KEY)).toMatchObject({ maxAmountMinor: 150_000, auto: false });

    expect(screen.getByTestId('ask-auto')).toHaveTextContent(/^Do this automatically for new FACEBOOK SI payments\?/);
    await fireEvent.press(screen.getByRole('button', { name: 'Yes, do this automatically' }));
    await waitFor(async () => expect((await repo.listRules()).find((r) => r.matchKey === KEY)).toMatchObject({ auto: true, account: 'Advertising - ZP' }));
    expect(screen.queryByTestId('ask-auto')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Inbox' }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/inbox');
  });

  it('Not now keeps the rule manual', async () => {
    const { Wrap, repo } = await setup({ txns: [fb('a', 100), fb('b', 200)], rules: [ADS] });
    confirmWith('Apply to 2');
    await render(<Wrap><BulkScreen /></Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Apply to 2' }));
    await fireEvent.press(await screen.findByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('ask-auto')).toBeNull();
    expect((await repo.listRules()).find((r) => r.matchKey === KEY)?.auto).toBe(false);
  });

  it('cancelling the dialog sends nothing', async () => {
    const { Wrap, erp } = await setup({ txns: [fb('a', 100), fb('b', 200)], rules: [ADS] });
    confirmWith('Cancel');
    await render(<Wrap><BulkScreen /></Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Apply to 2' }));
    expect(erp.createDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId('bulk-result')).toBeNull();
  });

  it('choosing the answer once: Expense, then the account; only bulk answers that fit are offered', async () => {
    const erp = fakeInboxErp();
    erp.listLedgerAccounts.mockResolvedValue([{ name: 'Advertising - ZP', accountType: null }, { name: 'Travel - ZP', accountType: null }]);
    const { Wrap } = await setup({ txns: [fb('a', 100), fb('b', 200)], erp });
    await render(<Wrap><BulkScreen /></Wrap>);
    expect(await screen.findByTestId('bulk-answer')).toHaveTextContent('Not chosen yet');
    expect(screen.getByRole('button', { name: 'Apply to 2' }).props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByRole('button', { name: 'Choose the answer' }));
    const labels = screen.getAllByRole('radio').map((r) => r.props.accessibilityLabel as string);
    expect(labels.map((l) => l.split('.')[0])).toEqual(['Expense', 'Personal', 'Ignore this message']);
    await fireEvent.press(screen.getByRole('radio', { name: /^Expense/ }));
    await fireEvent.press(await screen.findByRole('radio', { name: 'Travel - ZP' }));
    expect(erp.listLedgerAccounts).toHaveBeenCalledWith('ZP', { rootType: 'Expense' });
    expect(screen.getByTestId('bulk-answer')).toHaveTextContent('Expense, Travel');
    expect(screen.getByRole('button', { name: 'Apply to 2' }).props.accessibilityState).toMatchObject({ disabled: false });
  });

  it('signed out: Apply goes to sign in and sends nothing', async () => {
    const { Wrap } = await setup({ txns: [fb('a', 100), fb('b', 200)], rules: [ADS], erp: null });
    confirmWith('Apply to 2');
    await render(<Wrap><BulkScreen /></Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Apply to 2' }));
    expect(mockRouter.push).toHaveBeenCalledWith('/(auth)/login');
    expect(screen.queryByTestId('bulk-result')).toBeNull();
  });

  it('a foreign-currency item is listed but not ticked', async () => {
    const { Wrap } = await setup({ txns: [fb('a', 100), fb('b', 200), fb('u', 300, { currency: 'USD' })], rules: [ADS] });
    await render(<Wrap><BulkScreen /></Wrap>);
    expect((await screen.findByTestId('item-u')).props.accessibilityState).toMatchObject({ checked: false, disabled: true });
    expect(screen.getByRole('button', { name: 'Apply to 2' })).toBeTruthy();
  });

  it('nothing left: says so and goes back to the Inbox', async () => {
    const { Wrap } = await setup({ txns: [fb('a', 100, { state: 'created' })] });
    await render(<Wrap><BulkScreen /></Wrap>);
    expect(await screen.findByText('Nothing left to answer here')).toBeTruthy();
    await act(async () => { await fireEvent.press(screen.getByRole('button', { name: 'Back to Inbox' })); });
    expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/inbox');
  });
});
