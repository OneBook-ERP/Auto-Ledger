import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ErpAuthError, ErpNetworkError, type ErpClient } from '../erp/client';
import type { AccountMapping, PendingTxn } from '../core/types';
import { fakeApp } from '../state/testUtils';
import { useUiStore } from '../state/store';
import { HOME_CACHE_KEY, LAST_SYNCED_KEY, serializeHomeCache } from './viewModel';
import { COMPANY_KEY } from '../state/useSetting';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const React = require('react');
  return { useRouter: () => ({ push: mockPush }), useFocusEffect: (cb: () => void) => React.useEffect(cb, [cb]) };
});
import Home from '../../app/(tabs)/home';

const SITE = 'https://a.example';
const NOW = Date.now();
const mapping = (n: string, kind: 'bank' | 'card' = 'bank', last4 = '6507'): AccountMapping => ({ bankAccount: n, glAccount: `${n} - GL`, kind, senderIds: [], last4: [last4], modeOfPayment: 'Bank' });
const txn = (o: Partial<PendingTxn>): PendingTxn => ({
  id: Math.random().toString(), mergedCount: 1, state: 'created', createdDocs: [], error: null, kind: 'ca_credit', direction: 'in', amountMinor: 100, currency: 'INR',
  occurredOn: '2026-11-01', occurredTime: null, accountType: 'bank', accountLast4: '6507', counterparty: null, utr: null, merchant: null, balanceMinor: null, sender: 'X',
  receivedAt: 1, rawHash: Math.random().toString(), ...o,
});

function fakeClient(opts: { balance?: number; fail?: unknown } = {}): ErpClient & { get: jest.Mock; call: jest.Mock } {
  const get = jest.fn(async () => {
    if (opts.fail) throw opts.fail;
    return { message: [{ debit: (opts.balance ?? 512932.76) + 10, credit: 10 }] };
  });
  const call = jest.fn(async (_m: string, p: { report_name: string }) => {
    if (opts.fail) throw opts.fail;
    return { columns: [{ fieldname: 'outstanding' }], result: [[p.report_name.includes('Receivable') ? 1121725 : 250526]] };
  });
  return { get, call } as never;
}

async function setup(o: { mappings?: AccountMapping[]; pending?: PendingTxn[]; synced?: number | null; client?: ReturnType<typeof fakeClient>; cache?: object; site?: string } = {}) {
  const app = await fakeApp({ client: (o.client ?? fakeClient()) as never });
  for (const m of o.mappings ?? [mapping('IDFC')]) await app.repo.saveMapping(m);
  for (const t of o.pending ?? []) await app.repo.upsertPending(t);
  await app.repo.setSetting(COMPANY_KEY, 'Acme');
  if (o.synced !== null) await app.repo.setSetting(LAST_SYNCED_KEY, String(o.synced ?? Date.now() - 120_000));
  if (o.cache) await app.repo.setSetting(HOME_CACHE_KEY, serializeHomeCache(o.cache as never));
  useUiStore.getState().setBoot({ session: { siteUrl: o.site ?? SITE, user: 'u' }, setupDone: true });
  const utils = await render(<app.Wrap><Home /></app.Wrap>);
  return { app, ...utils };
}

beforeEach(() => mockPush.mockClear());

it('renders figures with last synced and drafts beside them, no banners when all is well', async () => {
  await setup({ pending: [txn({ amountMinor: 13046600 })] });
  await waitFor(() => expect(screen.getByLabelText(/^Bank balance · IDFC ₹5,12,932.76/)).toBeTruthy());
  expect(screen.getByLabelText(/^To receive ₹11,21,725, After advances/)).toBeTruthy();
  expect(screen.getByLabelText(/^To pay ₹2,50,526/)).toBeTruthy();
  expect(screen.getByText('1 draft. It is not in the figures above yet.')).toBeTruthy();
  expect(screen.getByText('₹1,30,466.00')).toBeTruthy();
  expect(screen.getByText('Last synced 2 minutes ago')).toBeTruthy();
  expect(screen.queryByTestId('banner-incomplete')).toBeNull();
  expect(screen.queryByTestId('banner-mismatch')).toBeNull();
});

it('drafts alone do not raise the incomplete banner; plural wording and foreign currency footnote', async () => {
  await setup({ pending: [txn({}), txn({}), txn({ currency: 'USD' })] });
  await waitFor(() => screen.getByText('3 drafts. They are not in the figures above yet.'));
  expect(screen.getByText('plus 1 in other currencies')).toBeTruthy();
  expect(screen.queryByTestId('banner-incomplete')).toBeNull();
});

it('unanswered messages show the incomplete banner with a link to the Inbox', async () => {
  await setup({ pending: [txn({ state: 'new' }), txn({ state: 'new' })] });
  await waitFor(() => screen.getByTestId('banner-incomplete'));
  expect(screen.getByText('2 messages need an answer.')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Answer messages' }));
  expect(mockPush).toHaveBeenCalledWith('/(tabs)/inbox');
});

it('a stale sync shows the banner without an Inbox link; never synced says so', async () => {
  const { unmount } = await setup({ synced: Date.now() - 25 * 3600_000 });
  await waitFor(() => screen.getByText('Not synced for more than a day.'));
  expect(screen.queryByRole('button', { name: 'Answer messages' })).toBeNull();
  await unmount();
  await setup({ synced: null });
  await waitFor(() => screen.getByText('Not synced yet.'));
});

it('a differing latest bank message shows a gentle mismatch banner', async () => {
  await setup({ pending: [txn({ state: 'submitted', receivedAt: 9, balanceMinor: 50000000 })] });
  await waitFor(() => screen.getByTestId('banner-mismatch'));
  expect(screen.getByText('This may be because a draft is waiting or a message is unanswered.')).toBeTruthy();
  expect(screen.queryByTestId('banner-incomplete')).toBeNull();
});

it('several bank accounts show a total and per-account lines; cards are left out', async () => {
  await setup({ mappings: [mapping('A', 'bank', '1111'), mapping('B', 'bank', '2222'), mapping('C', 'card', '3333')] });
  await waitFor(() => screen.getByLabelText(/^Bank balance ₹10,25,865.52/));
  expect(screen.getByLabelText('A ₹5,12,932.76')).toBeTruthy();
  expect(screen.getByLabelText('B ₹5,12,932.76')).toBeTruthy();
  expect(screen.queryByText('C')).toBeNull();
});

it('when ERPNext fails, shows cached figures labelled "as of" with a could-not-refresh note', async () => {
  await setup({
    client: fakeClient({ fail: new ErpNetworkError('offline') }),
    cache: { at: Date.now() - 3_600_000, site: SITE, balances: { 'IDFC - GL': 4000000 }, receivableMinor: 100000, payableMinor: 200000 },
  });
  await waitFor(() => screen.getByText('Could not refresh. Pull down to try again.'));
  expect(screen.getByLabelText(/^Bank balance · IDFC ₹40,000.00, as of 1 hour ago/)).toBeTruthy();
});

it('an auth error with cached figures shows them and a sign-in prompt without crashing', async () => {
  await setup({
    client: fakeClient({ fail: new ErpAuthError('no', 401) }),
    cache: { at: Date.now() - 60_000, site: SITE, balances: { 'IDFC - GL': 100 }, receivableMinor: 0, payableMinor: 0 },
  });
  await waitFor(() => screen.getByText(/sign-in has expired/));
  expect(screen.getByLabelText(/^Bank balance · IDFC ₹1.00/)).toBeTruthy();
});

it('with no cache an error shows an empty state with Retry that refetches', async () => {
  const client = fakeClient({ fail: new ErpNetworkError('offline') });
  await setup({ client });
  await waitFor(() => screen.getByText("Couldn't load your figures"));
  const before = client.get.mock.calls.length;
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(client.get.mock.calls.length).toBeGreaterThan(before));
});

it('a cache saved for another site is ignored', async () => {
  await setup({
    client: fakeClient({ fail: new ErpNetworkError('offline') }),
    cache: { at: 1, site: 'https://other.example', balances: { 'IDFC - GL': 100 }, receivableMinor: 0, payableMinor: 0 },
  });
  await waitFor(() => screen.getByText("Couldn't load your figures"));
});

it('a successful fetch saves the cache', async () => {
  const { app } = await setup();
  await waitFor(() => screen.getByLabelText(/^To pay ₹2,50,526/));
  await waitFor(async () => expect(JSON.parse((await app.repo.getSetting(HOME_CACHE_KEY)) as string)).toMatchObject({ site: SITE, receivableMinor: 112172500 }));
});

it('pull-to-refresh runs the foreground cycle and re-fetches', async () => {
  const client = fakeClient();
  const { app } = await setup({ client });
  await waitFor(() => screen.getByLabelText(/^To pay/));
  const before = client.call.mock.calls.length;
  await act(async () => {
    await fireEvent(screen.getByTestId('screen-scroll').children[0] as never, 'refresh');
  });
  expect(app.value.runCycle).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(client.call.mock.calls.length).toBeGreaterThan(before));
});

it('query keys include the site: another site refetches instead of reusing the first site data', async () => {
  const client = fakeClient();
  const { app, rerender } = await setup({ client });
  await waitFor(() => screen.getByLabelText(/^To pay/));
  const calls = client.call.mock.calls.length;
  await act(async () => useUiStore.getState().setSession({ siteUrl: 'https://b.example', user: 'u' }));
  await rerender(<app.Wrap><Home /></app.Wrap>);
  await waitFor(() => expect(client.call.mock.calls.length).toBeGreaterThan(calls));
});
