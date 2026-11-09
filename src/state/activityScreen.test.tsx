import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import type { PendingTxn } from '../core/types';
import type { Repo } from '../data/repo';
import { ErpNetworkError } from '../erp/client';
import { FakeDocsErp } from '../outbox/fakeErp.testutil';
import type { ErpOps } from '../outbox/runner';
import { fakeApp } from './testUtils';
import { useUiStore } from './store';

jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: { children?: unknown }) => <View>{p.children as never}</View> };
});
const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn() }),
    useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]),
  };
});
let mockErp: unknown = null;
jest.mock('./useErpOps', () => ({ useErpOps: () => mockErp }));

jest.mock('./activityModel', () => {
  const actual = jest.requireActual('./activityModel');
  return { ...actual, sortActivity: jest.fn(actual.sortActivity), filterActivity: jest.fn(actual.filterActivity) };
});
import * as activityModel from './activityModel';
import Activity, { OFFLINE_MESSAGE, OFFLINE_PUT_BACK_MESSAGE, UNDO_CONFIRM_MESSAGE } from '../../app/(tabs)/activity';

const doc = (name: string, docstatus = 0, doctype = 'Payment Entry') => ({ doctype, name, docstatus });
const txn = (id: string, over: Partial<PendingTxn> = {}): PendingTxn => ({
  id, mergedCount: 1, state: 'created', createdDocs: [doc(`PE-${id}`)], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 1234500, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: null, accountType: 'bank', accountLast4: '3455',
  counterparty: `Party ${id}`, utr: `U${id}`, merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1762300000000 + Number(id.replace(/\D/g, '') || 0), rawHash: `h${id}`, ...over,
});
const SUBMITTED_MSG = 'Your accountant already submitted this entry. Cancel it in ERPNext if it is wrong.';

async function open(txns: PendingTxn[], docs: Record<string, number> = {}, beforeRender?: (repo: Repo) => void) {
  const app = await fakeApp();
  for (const t of txns) await app.repo.upsertPending(t);
  beforeRender?.(app.repo);
  await app.repo.setSetting('site_url', 'https://erp.example.com');
  const erp = new FakeDocsErp(docs);
  mockErp = erp as unknown as ErpOps;
  useUiStore.setState({ session: { siteUrl: 'https://erp.example.com', user: 'a@b.c' }, needsLogin: false });
  await render(<Activity />, { wrapper: app.Wrap });
  return { ...app, erp };
}

/** Taps the confirm button of the Alert shown by the last Alert.alert call. */
const confirm = async (label: string) => {
  const call = (Alert.alert as jest.Mock).mock.calls.at(-1)!;
  const btn = (call[2] as { text: string; onPress?: () => void }[]).find((b) => b.text === label)!;
  await act(async () => { btn.onPress?.(); });
};

beforeEach(() => {
  // "Today" for the recency groups and period chips is fixed: 9 Nov 2026.
  jest.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 9, 12, 0, 0).getTime());
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  mockPush.mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe('Activity screen', () => {
  it('reads only handled rows from the repo and never the whole table', async () => {
    const news = Array.from({ length: 30 }, (_, i) => txn(`n${i}`, { state: 'new', createdDocs: [] }));
    let spy!: jest.SpyInstance;
    await open([txn('1'), ...news], { 'Payment Entry:PE-1': 0 }, (repo) => { spy = jest.spyOn(repo, 'listPending'); });
    await screen.findByTestId('activity-row-1');
    expect(spy).toHaveBeenCalled();
    for (const call of spy.mock.calls) {
      const states = call[0] as string[] | string | undefined;
      expect(states).toBeDefined();
      expect([states].flat()).not.toContain('new');
    }
    const returned = await Promise.all(spy.mock.results.map((r) => r.value as Promise<PendingTxn[]>));
    expect(returned.flat().some((t) => t.state === 'new')).toBe(false);
  });

  it('typing in search or opening the filters does not re-run the repo read, and unrelated renders do not re-sort', async () => {
    let spy!: jest.SpyInstance;
    await open([txn('1'), txn('2')], { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 0 }, (repo) => { spy = jest.spyOn(repo, 'listPending'); });
    await screen.findByTestId('activity-row-1');
    const reads = spy.mock.calls.length;
    const sorts = (activityModel.sortActivity as jest.Mock).mock.calls.length;
    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Close filters' }));
    expect(spy.mock.calls.length).toBe(reads);
    expect((activityModel.sortActivity as jest.Mock).mock.calls.length).toBe(sorts);
    await fireEvent.changeText(screen.getByTestId('activity-search'), 'Party 2');
    expect(spy.mock.calls.length).toBe(reads);
    expect((activityModel.sortActivity as jest.Mock).mock.calls.length).toBeGreaterThan(sorts);
  });

  it('shows the empty state when there is no activity', async () => {
    await open([txn('1', { state: 'new', createdDocs: [] })]);
    expect(await screen.findByText('Nothing processed yet')).toBeTruthy();
  });

  it('groups rows into sections, newest first, with amount, document, and status text', async () => {
    await open(
      [
        txn('1'),
        txn('2', { createdDocs: [doc('PE-2')], direction: 'out', counterparty: 'Vendor Two', amountMinor: 50000 }),
        txn('3', { state: 'submitted', createdDocs: [doc('JV-3', 1, 'Journal Entry')] }),
        txn('4', { state: 'ignored', createdDocs: [] }),
        txn('5', { state: 'new', createdDocs: [] }),
      ],
      { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 0, 'Journal Entry:JV-3': 1 },
    );
    expect(await screen.findByText('This week (4)')).toBeTruthy();
    const r2 = screen.getByTestId('activity-row-2');
    expect(within(r2).getByText('Vendor Two')).toBeTruthy();
    expect(within(r2).getByText('\u2212₹500.00')).toBeTruthy();
    expect(within(r2).getByText('Payment entry')).toBeTruthy();
    expect(within(r2).getByText('PE-2')).toBeTruthy();
    expect(within(r2).getByText('5 Nov 2026')).toBeTruthy();
    expect(within(r2).getByText('Draft')).toBeTruthy();
    expect(within(screen.getByTestId('activity-row-3')).getByText('Submitted')).toBeTruthy();
    expect(within(screen.getByTestId('activity-row-1')).getByText('+₹12,345.00')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-5')).toBeNull();
    // newest first
    const order = screen.getAllByTestId(/^activity-row-/).map((n) => n.props.testID);
    expect(order).toEqual(['activity-row-4', 'activity-row-3', 'activity-row-2', 'activity-row-1']);
  });

  it('offers Undo only when every document is a draft', async () => {
    await open(
      [txn('1'), txn('2', { createdDocs: [doc('PE-2', 1)] }), txn('3', { createdDocs: [doc('PE-3', 0), doc('PE-4', 1)] }), txn('4', { state: 'submitted', createdDocs: [doc('PE-5', 1)] })],
      { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 1, 'Payment Entry:PE-3': 0, 'Payment Entry:PE-4': 1, 'Payment Entry:PE-5': 1 },
    );
    await screen.findByTestId('activity-row-1');
    expect(within(screen.getByTestId('activity-row-1')).getByRole('button', { name: 'Undo' })).toBeTruthy();
    for (const id of ['3', '4']) expect(within(screen.getByTestId(`activity-row-${id}`)).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('Undo asks first; cancelling does nothing; confirming undoes and refreshes', async () => {
    const { repo, erp } = await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    await fireEvent.press(await screen.findByRole('button', { name: 'Undo' }));
    expect(Alert.alert).toHaveBeenCalledWith('Undo this entry?', UNDO_CONFIRM_MESSAGE, expect.any(Array), expect.anything());
    expect(UNDO_CONFIRM_MESSAGE).toBe('Remove the draft from ERPNext and put this message back in your Inbox?');
    expect(erp.count('deleteDraft')).toBe(0);
    await confirm('Undo');
    await waitFor(() => expect(screen.queryByTestId('activity-row-1')).toBeNull());
    expect((await repo.getPending('1'))!.state).toBe('new');
    expect(erp.count('deleteDraft')).toBe(1);
    expect(screen.getByText('Put back in your Inbox.')).toBeTruthy();
  });

  it('shows a banner when the accountant already submitted, and refreshes the row', async () => {
    const { erp } = await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    await screen.findByRole('button', { name: 'Undo' });
    erp.docs.set('Payment Entry:PE-1', 1); // submitted after the last poll
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await confirm('Undo');
    expect(await screen.findByText(SUBMITTED_MSG)).toBeTruthy();
    const row = await screen.findByTestId('activity-row-1');
    expect(within(row).getByText('Submitted')).toBeTruthy();
    expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('a network failure shows "No connection" with Retry that finishes the job', async () => {
    const { erp, repo } = await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    await screen.findByRole('button', { name: 'Undo' });
    erp.failNext('getDocStatuses', new ErpNetworkError('offline'));
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await confirm('Undo');
    expect(await screen.findByText(OFFLINE_MESSAGE)).toBeTruthy();
    expect(OFFLINE_MESSAGE).toBe('No connection. Nothing was removed yet.');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
  });

  it('needs_login routes to the login screen', async () => {
    const { erp } = await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    await screen.findByRole('button', { name: 'Undo' });
    const { ErpAuthError } = require('../erp/client');
    erp.failNext('getDocStatuses', new ErpAuthError('401', 401));
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    await confirm('Undo');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/(auth)/login'));
    expect(useUiStore.getState().needsLogin).toBe(true);
  });

  it('cancelled and missing documents get a status, an explanation and "Put back in Inbox"', async () => {
    const { repo, erp } = await open(
      [txn('1', { createdDocs: [doc('PE-1')] }), txn('2', { createdDocs: [doc('PE-2')] })],
      { 'Payment Entry:PE-1': 2 }, // PE-2 is missing from the server
    );
    const r1 = await screen.findByTestId('activity-row-1');
    await waitFor(() => expect(within(screen.getByTestId('activity-row-1')).getByText('Cancelled in ERPNext')).toBeTruthy());
    const r2 = screen.getByTestId('activity-row-2');
    expect(within(r2).getByText('Not found in ERPNext')).toBeTruthy();
    expect(within(r1).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(r2).queryByRole('button', { name: 'Open in ERPNext' })).toBeNull();
    erp.calls.length = 0;
    await fireEvent.press(within(r2).getByRole('button', { name: 'Put back in Inbox' }));
    await waitFor(async () => expect((await repo.getPending('2'))!.state).toBe('new'));
    expect(erp.count('deleteDraft')).toBe(0);
  });

  it('"Bring back" returns an ignored entry to the Inbox with no ERPNext call', async () => {
    const { repo, erp } = await open([txn('1', { state: 'ignored', createdDocs: [] })]);
    await fireEvent.press(await screen.findByRole('button', { name: 'Bring back' }));
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
    expect(erp.calls).toHaveLength(0);
  });

  it('"Open in ERPNext" links to the document page', async () => {
    await open([txn('1', { createdDocs: [doc('PE 1/a')] })], { 'Payment Entry:PE 1/a': 0 });
    await fireEvent.press(await screen.findByRole('button', { name: 'Open in ERPNext' }));
    expect(Linking.openURL).toHaveBeenCalledWith('https://erp.example.com/app/payment-entry/PE%201%2Fa');
  });

  it('polls on focus: a submitted draft moves to the Submitted section', async () => {
    await open([txn('1')], { 'Payment Entry:PE-1': 1 });
    expect(await within(await screen.findByTestId('activity-row-1')).findByText('Submitted')).toBeTruthy();
  });

  it('limits the list to 100 items with a Show older control', async () => {
    const many = Array.from({ length: 105 }, (_, i) => txn(String(i + 1), { state: 'ignored', createdDocs: [] }));
    await open(many);
    await screen.findByText('This week (100)');
    await fireEvent.press(screen.getByRole('button', { name: 'Show older (5 more)' }));
    expect(await screen.findByText('This week (105)')).toBeTruthy();
  });

  it('shows amounts in the transaction currency, not always rupees', async () => {
    await open([txn('1', { currency: 'USD', amountMinor: 12345, createdDocs: [doc('PE-1')] })], { 'Payment Entry:PE-1': 0 });
    expect(await screen.findByText('+USD 123.45')).toBeTruthy();
  });

  it('adopted drafts: the dialog says it only unlinks, nothing is deleted', async () => {
    const { repo, erp } = await open([txn('1', { createdDocs: [{ ...doc('PE-1'), adopted: true }] })], { 'Payment Entry:PE-1': 0 });
    await fireEvent.press(await screen.findByRole('button', { name: 'Undo' }));
    const call = (Alert.alert as jest.Mock).mock.calls.at(-1)!;
    expect(call[1]).toBe('This entry was already in ERPNext before this app recorded it. It stays there; only the link to this message is removed.');
    await confirm('Undo');
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
    expect(erp.count('deleteDraft')).toBe(0);
    expect(await screen.findByText(/PE-1 stays in ERPNext/)).toBeTruthy();
  });

  it('Undo knows about a document held by a row in any state, including an unanswered one', async () => {
    await open([
      txn('1', { createdDocs: [doc('PE-1')] }),
      txn('2', { state: 'new', createdDocs: [doc('PE-1')] }), // a partial failure left the same draft on an unanswered row
    ], { 'Payment Entry:PE-1': 0 });
    await fireEvent.press(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect((Alert.alert as jest.Mock).mock.calls.at(-1)![1]).toContain('also linked to another message');
  });

  it('Put back in Inbox asks first when it will delete a draft, and offline says nothing was changed', async () => {
    const { repo, erp } = await open([txn('1', { createdDocs: [doc('PE-1'), doc('PE-2')] })], { 'Payment Entry:PE-1': 2, 'Payment Entry:PE-2': 0 });
    await waitFor(() => expect(screen.getByText('Cancelled in ERPNext')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Put back in Inbox' }));
    expect((Alert.alert as jest.Mock).mock.calls.at(-1)![1]).toBe(UNDO_CONFIRM_MESSAGE);
    erp.failNext('getDocStatuses', new ErpNetworkError('offline'));
    await confirm('Put back');
    expect(await screen.findByText(OFFLINE_PUT_BACK_MESSAGE)).toBeTruthy();
    expect(OFFLINE_PUT_BACK_MESSAGE).toBe('No connection. Nothing was changed.');
    expect((await repo.getPending('1'))!.state).toBe('created');
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
  });

  it('a second tap while the confirm dialog is open does not open another', async () => {
    await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    const btn = await screen.findByRole('button', { name: 'Undo' });
    await fireEvent.press(btn);
    await fireEvent.press(btn);
    expect(Alert.alert).toHaveBeenCalledTimes(1);
  });

  it('does not poll or undo against a different site than the saved data', async () => {
    const app = await fakeApp();
    await app.repo.upsertPending(txn('1'));
    await app.repo.setSetting('site_url', 'https://other.example.com');
    const erp = new FakeDocsErp({ 'Payment Entry:PE-1': 1 });
    mockErp = erp as unknown as ErpOps;
    useUiStore.setState({ session: { siteUrl: 'https://erp.example.com', user: 'a@b.c' }, needsLogin: false });
    await render(<Activity />, { wrapper: app.Wrap });
    await screen.findByTestId('activity-row-1');
    expect(erp.calls).toHaveLength(0);
  });
});

describe('Activity search, period and totals', () => {
  const mixed = () => [
    txn('1', { counterparty: 'Fuel Station', occurredOn: '2026-11-05', amountMinor: 100000 }),
    txn('2', { counterparty: 'Rent', direction: 'out', occurredOn: '2026-10-20', amountMinor: 30000 }),
    txn('3', { counterparty: 'Client', occurredOn: '2026-11-08', amountMinor: 50050 }),
  ];
  const docs = { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 0, 'Payment Entry:PE-3': 0 };

  it('typing hides rows that do not match, case-insensitively; regex characters are plain text', async () => {
    await open(mixed(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.changeText(screen.getByTestId('activity-search'), '  FUEL ');
    expect(screen.getByTestId('activity-row-1')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-2')).toBeNull();
    expect(screen.queryByTestId('activity-row-3')).toBeNull();
    await fireEvent.changeText(screen.getByTestId('activity-search'), '(*');
    expect(await screen.findByText('Nothing matches. Try a different search or period.')).toBeTruthy();
  });

  it('period chips: Last month shows only last month, This month the rest', async () => {
    await open(mixed(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.press(screen.getByRole('radio', { name: 'Last month' }));
    expect(screen.getByTestId('activity-row-2')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-1')).toBeNull();
    await fireEvent.press(screen.getByRole('radio', { name: 'This month' }));
    expect(screen.queryByTestId('activity-row-2')).toBeNull();
    expect(screen.getByTestId('activity-row-1')).toBeTruthy();
    expect(screen.getByTestId('activity-row-3')).toBeTruthy();
  });

  it('the totals strip adds up the shown rows', async () => {
    await open(mixed(), docs);
    await screen.findByTestId('activity-row-1');
    const strip = screen.getByTestId('activity-totals');
    expect(within(strip).getByText('Money in')).toBeTruthy();
    expect(within(strip).getByText('₹1,500.50')).toBeTruthy();
    expect(within(strip).getByText('Money out')).toBeTruthy();
    expect(within(strip).getByText('₹300.00')).toBeTruthy();
    expect(within(strip).getByText('Net')).toBeTruthy();
    expect(within(strip).getByText('₹1,200.50')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Last month' }));
    expect(within(screen.getByTestId('activity-totals')).getByText('−₹300.00')).toBeTruthy();
  });

  it('Undo still works on a filtered row', async () => {
    const { repo } = await open(mixed(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.changeText(screen.getByTestId('activity-search'), 'fuel');
    await fireEvent.press(within(screen.getByTestId('activity-row-1')).getByRole('button', { name: 'Undo' }));
    await confirm('Undo');
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
  });

  it('Bring back works on a filtered ignored row', async () => {
    const { repo } = await open([txn('1', { state: 'ignored', createdDocs: [], counterparty: 'Spam' }), txn('2')], docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.changeText(screen.getByTestId('activity-search'), 'spam');
    await fireEvent.press(within(screen.getByTestId('activity-row-1')).getByRole('button', { name: 'Bring back' }));
    await waitFor(async () => expect((await repo.getPending('1'))!.state).toBe('new'));
  });
});

describe('Activity filter and sort sheet', () => {
  const data = () => [
    txn('1', { counterparty: 'Alpha', amountMinor: 100, accountLast4: '3455' }),
    txn('2', { counterparty: 'Bravo', direction: 'out', amountMinor: 900, accountLast4: '3455' }),
    txn('3', { counterparty: 'Charlie', direction: 'out', amountMinor: 500, accountLast4: '9999' }),
  ];
  const docs = { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 0, 'Payment Entry:PE-3': 0 };
  const order = () => screen.getAllByTestId(/^activity-row-/).map((n) => n.props.testID);

  it('shows direction, account and sort; Apply updates the list and the count; Reset clears', async () => {
    await open(data(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getAllByRole('radio', { name: 'All' })).toHaveLength(2);
    for (const name of ['Waiting for your accountant', 'Money in', 'Money out', 'Account ending 3455', 'Account ending 9999', 'Highest amount', 'Name A to Z']) {
      expect(screen.getByRole('radio', { name })).toBeTruthy();
    }
    await fireEvent.press(screen.getByRole('radio', { name: 'Money out' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Highest amount' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByTestId('activity-row-1')).toBeNull();
    expect(order()).toEqual(['activity-row-2', 'activity-row-3']);
    expect(screen.getByRole('button', { name: 'Filters (2)' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Filters (2)' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('button', { name: 'Filters' })).toBeTruthy();
    expect(screen.getByTestId('activity-row-1')).toBeTruthy();
  });

  it('filters by account', async () => {
    await open(data(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Account ending 9999' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(order()).toEqual(['activity-row-3']);
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeTruthy();
  });
});

describe('Activity triage and totals honesty', () => {
  const docs = { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 1, 'Payment Entry:PE-3': 0 };
  const data = () => [
    txn('1', { counterparty: 'Alpha' }),
    txn('2', { counterparty: 'Bravo', state: 'submitted', createdDocs: [doc('PE-2', 1)] }),
    txn('3', { counterparty: 'Charlie', state: 'ignored', createdDocs: [] }),
  ];

  it('says how many wait for the accountant; tapping applies the Waiting filter', async () => {
    await open(data(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.press(screen.getByRole('button', { name: '1 waiting for your accountant' }));
    expect(screen.getByTestId('activity-row-1')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-2')).toBeNull();
    expect(screen.queryByTestId('activity-row-3')).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeTruthy();
  });

  it('the waiting count follows the period chip and the search, and skips cancelled drafts', async () => {
    const d = [
      txn('1', { counterparty: 'Alpha' }),
      txn('2', { counterparty: 'Bravo', occurredOn: '2026-10-20', createdDocs: [doc('PE-2')] }),
      txn('3', { counterparty: 'Charlie', createdDocs: [doc('PE-3', 2)] }),
    ];
    await open(d, { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 0, 'Payment Entry:PE-3': 2 });
    await screen.findByTestId('activity-row-1');
    expect(screen.getByRole('button', { name: '2 waiting for your accountant' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Last month' }));
    expect(screen.getByRole('button', { name: '1 waiting for your accountant' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'All time' }));
    await fireEvent.changeText(screen.getByTestId('activity-search'), 'alpha');
    expect(screen.getByRole('button', { name: '1 waiting for your accountant' })).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: '1 waiting for your accountant' }));
    expect(screen.getByRole('button', { name: 'Filters (1)' })).toBeTruthy();
    expect((screen.getByTestId('activity-search').props as { value: string }).value).toBe('alpha');
  });

  it('the sheet has a status filter', async () => {
    await open(data(), docs);
    await screen.findByTestId('activity-row-1');
    await fireEvent.press(screen.getByRole('button', { name: 'Filters' }));
    await fireEvent.press(screen.getByRole('radio', { name: 'Ignored' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getAllByTestId(/^activity-row-/).map((n) => n.props.testID)).toEqual(['activity-row-3']);
  });

  it('totals do not count ignored items', async () => {
    await open(data(), docs);
    await screen.findByTestId('activity-row-1');
    // rows 1 and 2 are 12,345.00 each; the ignored row 3 is not added
    expect(within(screen.getByTestId('activity-totals')).getAllByText('₹24,690.00').length).toBeGreaterThan(0);
  });
});
