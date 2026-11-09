import { Alert } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AccountMapping } from '../src/core/types';
import { ErpClient } from '../src/erp/client';
import { useUiStore } from '../src/state/store';
import { fakeApp } from '../src/state/testUtils';
import Accounts from '../app/(setup)/accounts';
import Company from '../app/(setup)/company';
import Defaults from '../app/(setup)/defaults';
import Permissions, { DISCLOSURE_POINTS, DISCLOSURE_TITLE } from '../app/(setup)/permissions';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush, replace: mockReplace }), Redirect: () => null, Stack: () => null }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

function client(routes: Record<string, unknown>) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const hit = Object.keys(routes).find((k) => String(url).includes(k));
    return json({ data: hit ? routes[hit] : [] });
  }) as unknown as typeof fetch;
  return { c: new ErpClient({ siteUrl: 'https://x.example', apiKey: 'k', apiSecret: 's', fetchImpl }), urls };
}

const BANKS = [
  { name: 'IDFC First - ZP', account: 'IDFC First - ZP', bank_account_no: null, is_company_account: 1 },
  { name: 'IDFC Credit Card - ZP', account: 'IDFC Credit Card - ZP', bank_account_no: null, is_company_account: 1 },
  { name: 'ICICI - ZP', account: 'ICICI - ZP', bank_account_no: null, is_company_account: 1 },
];
const MODES = [{ name: 'Cash', type: 'Cash' }, { name: 'Credit Card', type: 'General' }, { name: 'Wire Transfer', type: 'Bank' }];

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
});

describe('company step', () => {
  it('auto-selects the only INR company and saves it', async () => {
    const { c } = client({ '/Company': [{ name: 'ZP Co', default_currency: 'INR' }] });
    const { Wrap, repo } = await fakeApp({ client: c });
    await render(<Wrap><Company /></Wrap>);
    await waitFor(() => expect(screen.getByRole('radio', { checked: true })).toBeTruthy());
    await press('Continue');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/(setup)/accounts'));
    expect(await repo.getSetting('company')).toBe('ZP Co');
  });
  it('explains that only INR companies work', async () => {
    const { c } = client({ '/Company': [{ name: 'US Co', default_currency: 'USD' }] });
    const { Wrap } = await fakeApp({ client: c });
    await render(<Wrap><Company /></Wrap>);
    expect(await screen.findByText('AutoLedger works with companies whose currency is INR. None of the companies on this site use INR.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue' }).props.accessibilityState.disabled).toBe(true);
  });
});

describe('query keys carry the site', () => {
  it("site A's company list is never offered while signed in to site B", async () => {
    const A = client({ '/Company': [{ name: 'A Co', default_currency: 'INR' }] }).c;
    const B = client({ '/Company': [{ name: 'B Co', default_currency: 'INR' }, { name: 'B Two', default_currency: 'INR' }] }).c;
    useUiStore.setState({ session: { siteUrl: 'https://a.example', user: 'u' } });
    const app = await fakeApp({ client: A });
    const view = await render(<app.Wrap><Company /></app.Wrap>);
    expect(await screen.findByText('A Co')).toBeTruthy();
    // sign-in to B without the provider clearing anything: the key alone must keep the lists apart
    app.value.client = B;
    await act(async () => useUiStore.setState({ session: { siteUrl: 'https://b.example', user: 'u' } }));
    await view.rerender(<app.Wrap><Company /></app.Wrap>);
    expect(await screen.findByText('B Two')).toBeTruthy();
    expect(screen.queryByText('A Co')).toBeNull();
    await act(async () => useUiStore.setState(useUiStore.getInitialState()));
  });
});

describe('accounts step', () => {
  const setup = async (existing: AccountMapping[] = []) => {
    const { c, urls } = client({ '/Bank%20Account': BANKS, '/Mode%20of%20Payment': MODES });
    const app = await fakeApp({ client: c });
    await app.repo.setSetting('company', 'ZP Co');
    for (const m of existing) await app.repo.saveMapping(m);
    await render(<app.Wrap><Accounts /></app.Wrap>);
    await screen.findByText('IDFC Credit Card - ZP');
    return { ...app, urls };
  };

  it('lets one card account take two last-4 values and persists both via saveMapping', async () => {
    const { repo } = await setup();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'IDFC Credit Card - ZP' }));
    await fireEvent.changeText(screen.getByLabelText('Last 4 digits for IDFC Credit Card - ZP'), '3455, 8129');
    expect(screen.getByLabelText('Sender id for IDFC Credit Card - ZP').props.value).toBe('IDFCFB');
    await press('Continue');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/(setup)/defaults'));
    expect(await repo.listMappings()).toEqual([
      { bankAccount: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Credit Card' },
    ]);
  });

  it('shows "This bank is not supported yet" for a non-IDFC bank and does not let it be selected', async () => {
    await setup();
    expect(screen.getByText('This bank is not supported yet')).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /ICICI - ZP/ }).props.accessibilityState.disabled).toBe(true);
  });

  it('a saved account cannot be un-ticked and says why', async () => {
    const existing: AccountMapping = { bankAccount: 'IDFC First - ZP', glAccount: 'IDFC First - ZP', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Wire Transfer' };
    await setup([existing]);
    expect(screen.getByRole('checkbox', { name: /IDFC First - ZP/ }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(/Saved accounts cannot be removed from the app yet/)).toBeTruthy();
  });

  it('requires at least one account and a valid last-4', async () => {
    const { repo } = await setup();
    await press('Continue');
    expect(await screen.findByText('Select at least one account to continue.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('checkbox', { name: 'IDFC First - ZP' }));
    await fireEvent.changeText(screen.getByLabelText('Last 4 digits for IDFC First - ZP'), '65');
    await press('Continue');
    expect(await screen.findByText('Each entry must be exactly 4 digits. Separate several with commas.')).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
    expect(await repo.listMappings()).toEqual([]);
  });

  it('re-running setup prefills the existing mapping and keeps it', async () => {
    const existing: AccountMapping = { bankAccount: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Cash' };
    const { repo } = await setup([existing]);
    expect(screen.getByRole('checkbox', { name: /IDFC Credit Card - ZP/ }).props.accessibilityState.checked).toBe(true);
    expect(screen.getByLabelText('Last 4 digits for IDFC Credit Card - ZP').props.value).toBe('3455, 8129');
    await press('Continue');
    await waitFor(() => expect(mockPush).toHaveBeenCalled());
    expect(await repo.listMappings()).toEqual([existing]);
  });
});

describe('defaults step', () => {
  it('saves drawings and default expense accounts in settings', async () => {
    const f = (async (url: string) => {
      const u = decodeURIComponent(String(url));
      if (u.includes('"Equity"')) return json({ data: [{ name: 'Drawings - ZP', account_type: 'Equity' }] });
      if (u.includes('"Liability"')) return json({ data: [{ name: 'Director Loan - ZP', account_type: null }] });
      return json({ data: [{ name: 'Rent - ZP', account_type: null }] });
    }) as unknown as typeof fetch;
    const cl = new ErpClient({ siteUrl: 'https://x.example', apiKey: 'k', apiSecret: 's', fetchImpl: f });
    const { Wrap, repo } = await fakeApp({ client: cl });
    await repo.setSetting('company', 'ZP Co');
    await render(<Wrap><Defaults /></Wrap>);
    await fireEvent.press(await screen.findByRole('radio', { name: 'Director Loan - ZP' }));
    await fireEvent.press(await screen.findByRole('radio', { name: 'Rent - ZP' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' }).props.accessibilityState.disabled).toBe(false));
    await press('Continue');
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/(setup)/permissions'));
    expect(await repo.getSetting('drawingsAccount')).toBe('Director Loan - ZP');
    expect(await repo.getSetting('defaultExpenseAccount')).toBe('Rent - ZP');
  });

  it('warns when both are left empty but still lets the user continue', async () => {
    const { c } = client({});
    const { Wrap } = await fakeApp({ client: c });
    await render(<Wrap><Defaults /></Wrap>);
    expect(await screen.findByText(/Without a drawings or director loan account and a default expense account/)).toBeTruthy();
  });
});

describe('permissions step', () => {
  it('shows the SMS disclosure BEFORE requestPermissions is called', async () => {
    const { Wrap, calls, mocks } = await fakeApp();
    await render(<Wrap><Permissions /></Wrap>);
    expect(screen.getByText(DISCLOSURE_TITLE)).toBeTruthy();
    for (const p of DISCLOSURE_POINTS) expect(screen.getByText(p)).toBeTruthy();
    expect(screen.getByText(/raw text never leaves the phone/)).toBeTruthy();
    expect(screen.getByText(/Transaction details go only to your own ERPNext site/)).toBeTruthy();
    expect(screen.getByText(/One-time passwords \(OTPs\) are ignored/)).toBeTruthy();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    await press('Continue');
    await waitFor(() => expect(mocks.requestPermissions).toHaveBeenCalledTimes(1));
    expect(calls.indexOf('requestPermissions')).toBeLessThan(calls.indexOf('hasPermission'));
    expect(await screen.findByText('Receive SMS')).toBeTruthy();
    expect(screen.getAllByText('Allowed')).toHaveLength(3);
  });

  it('explains restricted settings and the battery tip when permissions are missing', async () => {
    const app = await fakeApp();
    (app.mocks.hasPermission as jest.Mock).mockResolvedValue({ receive: false, read: false, notifications: true });
    await render(<app.Wrap><Permissions /></app.Wrap>);
    await press('Continue');
    expect(await screen.findByText('Some phones show this. If the permission dialog does not appear, open App info > Permissions.')).toBeTruthy();
    expect(screen.queryByText(/ColorOS|restricted settings/i)).toBeNull();
    expect(screen.getAllByText('Not allowed')).toHaveLength(2);
    expect(screen.getByText(/Allow background activity/)).toBeTruthy();
    expect(screen.getByText(/Turn off "Manage app if unused" for AutoLedger/)).toBeTruthy();
    expect(screen.getByText(/does not remove the SMS permission after a quiet month|so Android does not remove the SMS permission after a quiet month/)).toBeTruthy();
    expect(screen.queryByText(/we tested/)).toBeNull();
  });

  it('finishing with SMS denied explains that bank messages are not read, and can be cancelled', async () => {
    const app = await fakeApp();
    (app.mocks.hasPermission as jest.Mock).mockResolvedValue({ receive: false, read: false, notifications: true });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => void b?.find((x) => x.text === 'Go back')?.onPress?.());
    await render(<app.Wrap><Permissions /></app.Wrap>);
    await press('Continue');
    await screen.findByText('Receive SMS');
    await press('Finish setup');
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][0]).toBe('SMS permission is off');
    expect(alert.mock.calls[0][1]).toMatch(/will NOT read your bank messages until SMS permission is granted/);
    expect(app.value.completeSetup).not.toHaveBeenCalled();
    alert.mockImplementation((_t, _m, b) => void b?.find((x: { text?: string }) => x.text === 'Finish anyway')?.onPress?.());
    await press('Finish setup');
    await waitFor(() => expect(app.value.completeSetup).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home');
  });

  it('asks how far back to look and saves the choice as backfill_days', async () => {
    const app = await fakeApp();
    await render(<app.Wrap><Permissions /></app.Wrap>);
    expect(screen.getByText('How far back should we look?')).toBeTruthy();
    for (const l of ['1 week', '1 month', '3 months', '6 months']) expect(screen.getByRole('button', { name: l })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1 week' }).props.accessibilityState).toMatchObject({ selected: true });
    await press('3 months');
    await waitFor(async () => expect(await app.repo.getSetting('backfill_days')).toBe('90'));
    expect(screen.getByRole('button', { name: '3 months' }).props.accessibilityState).toMatchObject({ selected: true });
  });

  it('disclosure no longer fixes the period at 7 days and says only your set up senders are read', async () => {
    const app = await fakeApp();
    await render(<app.Wrap><Permissions /></app.Wrap>);
    const all = DISCLOSURE_POINTS.join(' ');
    expect(all).not.toMatch(/7 days|seven/i);
    expect(all).toMatch(/only text messages from the bank senders you set up/);
    expect(all).toMatch(/period you choose/);
  });

  it('after the first scan shows how many transactions were found, then continues', async () => {
    const app = await fakeApp();
    await app.repo.saveMapping({ bankAccount: 'IDFC', glAccount: 'IDFC - ZP', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Wire Transfer' });
    const fx = (require('../fixtures/sms/idfc.json') as { id: string; sender: string; body: string; receivedAt: number }[]).find((f) => f.id === 'idfc-001')!;
    (app.mocks.backfill as jest.Mock).mockResolvedValue([{ sender: fx.sender, body: fx.body, receivedAt: fx.receivedAt }]);
    await render(<app.Wrap><Permissions /></app.Wrap>);
    await press('1 month');
    await press('Continue');
    await screen.findByText('Receive SMS');
    await press('Finish setup');
    expect(await screen.findByText('Found 1 transaction')).toBeTruthy();
    expect(app.mocks.backfill).toHaveBeenCalledWith(30, ['IDFCFB']);
    expect(app.value.completeSetup).not.toHaveBeenCalled();
    await press('Continue');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(app.value.completeSetup).toHaveBeenCalledTimes(1);
  });

  it('finishing syncs sender patterns, completes setup and goes to Home', async () => {
    const app = await fakeApp();
    await app.repo.saveMapping({ bankAccount: 'IDFC', glAccount: 'IDFC - ZP', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Wire Transfer' });
    await render(<app.Wrap><Permissions /></app.Wrap>);
    await press('Continue');
    await screen.findByText('Receive SMS');
    await press('Finish setup');
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/home'));
    expect(app.mocks.setSenderPatterns).toHaveBeenCalledWith(['IDFCFB']);
    expect(app.value.completeSetup).toHaveBeenCalledTimes(1);
    expect(app.calls.indexOf('setSenderPatterns')).toBeLessThan(app.calls.length);
  });
});
