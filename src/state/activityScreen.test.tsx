import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert, Linking } from 'react-native';
import type { PendingTxn } from '../core/types';
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

import Activity, { OFFLINE_MESSAGE, UNDO_CONFIRM_MESSAGE } from '../../app/(tabs)/activity';

const doc = (name: string, docstatus = 0, doctype = 'Payment Entry') => ({ doctype, name, docstatus });
const txn = (id: string, over: Partial<PendingTxn> = {}): PendingTxn => ({
  id, mergedCount: 1, state: 'created', createdDocs: [doc(`PE-${id}`)], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 1234500, currency: 'INR',
  occurredOn: '2026-11-05', occurredTime: null, accountType: 'bank', accountLast4: '3455',
  counterparty: `Party ${id}`, utr: `U${id}`, merchant: null, balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1762300000000 + Number(id.replace(/\D/g, '') || 0), rawHash: `h${id}`, ...over,
});
const SUBMITTED_MSG = 'Your accountant already submitted this entry. Cancel it in ERPNext if it is wrong.';

async function open(txns: PendingTxn[], docs: Record<string, number> = {}) {
  const app = await fakeApp();
  for (const t of txns) await app.repo.upsertPending(t);
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
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
  mockPush.mockClear();
});
afterEach(() => jest.restoreAllMocks());

describe('Activity screen', () => {
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
    expect(await screen.findByText('Waiting for your accountant (2)')).toBeTruthy();
    expect(screen.getByText('Submitted (1)')).toBeTruthy();
    expect(screen.getByText('Ignored (1)')).toBeTruthy();
    const r2 = screen.getByTestId('activity-row-2');
    expect(within(r2).getByText('Vendor Two')).toBeTruthy();
    expect(within(r2).getByText('-₹500.00')).toBeTruthy();
    expect(within(r2).getByText('Payment Entry PE-2')).toBeTruthy();
    expect(within(r2).getByText('Draft')).toBeTruthy();
    expect(within(screen.getByTestId('activity-row-3')).getByText('Submitted')).toBeTruthy();
    expect(within(screen.getByTestId('activity-row-1')).getByText('+₹12,345.00')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-5')).toBeNull();
    // row 2 is newer than row 1
    const order = screen.getAllByTestId(/^activity-row-/).map((n) => n.props.testID);
    expect(order).toEqual(['activity-row-2', 'activity-row-1', 'activity-row-3', 'activity-row-4']);
  });

  it('offers Undo only when every document is a draft', async () => {
    await open(
      [txn('1'), txn('2', { createdDocs: [doc('PE-2', 1)] }), txn('3', { createdDocs: [doc('PE-3', 0), doc('PE-4', 1)] }), txn('4', { state: 'submitted', createdDocs: [doc('PE-5', 1)] })],
      { 'Payment Entry:PE-1': 0, 'Payment Entry:PE-2': 1, 'Payment Entry:PE-3': 0, 'Payment Entry:PE-4': 1, 'Payment Entry:PE-5': 1 },
    );
    await screen.findByText('Waiting for your accountant (2)');
    expect(within(screen.getByTestId('activity-row-1')).getByRole('button', { name: 'Undo' })).toBeTruthy();
    for (const id of ['3', '4']) expect(within(screen.getByTestId(`activity-row-${id}`)).queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('Undo asks first; cancelling does nothing; confirming undoes and refreshes', async () => {
    const { repo, erp } = await open([txn('1')], { 'Payment Entry:PE-1': 0 });
    await fireEvent.press(await screen.findByRole('button', { name: 'Undo' }));
    expect(Alert.alert).toHaveBeenCalledWith('Undo this entry?', UNDO_CONFIRM_MESSAGE, expect.any(Array));
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
    expect(await screen.findByText('Submitted (1)')).toBeTruthy();
    expect(screen.queryByText(/Waiting for your accountant/)).toBeNull();
  });

  it('limits the list to 100 items with a Show older control', async () => {
    const many = Array.from({ length: 105 }, (_, i) => txn(String(i + 1), { state: 'ignored', createdDocs: [] }));
    await open(many);
    await screen.findByText('Ignored (100)');
    await fireEvent.press(screen.getByRole('button', { name: 'Show older (5 more)' }));
    expect(await screen.findByText('Ignored (105)')).toBeTruthy();
  });
});
