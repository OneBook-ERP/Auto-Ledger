import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import Activity from '../app/(tabs)/activity';
import Inbox from '../app/(tabs)/inbox';
import Settings from '../app/(tabs)/settings';
import TabsLayout from '../app/(tabs)/_layout';
import DebugReceiver from '../app/debug-receiver';
import { AppBanners, ENGINE_UNAVAILABLE, SIGN_IN_AGAIN } from '../src/state/AppBanners';
import { useUiStore } from '../src/state/store';
import { fakeApp } from '../src/state/testUtils';

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const { Text: T, View: V } = require('react-native');
  const Tabs = Object.assign(({ children }: { children: unknown }) => <V testID="tabs">{children as never}</V>, {
    Screen: ({ name, options }: { name: string; options: { title: string } }) => <T testID={`tab-${name}`}>{options.title}</T>,
  });
  return {
    useRouter: () => ({ push: mockPush, replace: mockReplace }),
    Redirect: ({ href }: { href: string }) => <T testID="redirect">{href}</T>,
    Tabs,
  };
});
jest.mock('../src/state/native', () => ({ getNative: () => ({}) }));

const reset = (p: Partial<ReturnType<typeof useUiStore.getState>> = {}) => useUiStore.setState({ ...useUiStore.getInitialState(), ...p });
const signedIn = { boot: 'ready' as const, session: { siteUrl: 'https://atom.example.app', user: 'a@b.co' }, setupDone: true };

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  reset();
});

describe('tabs shell', () => {
  it('defines home, inbox (autoledger://inbox target), activity and settings', async () => {
    reset(signedIn);
    await render(<TabsLayout />);
    expect(['home', 'inbox', 'activity', 'settings'].map((n) => screen.getByTestId(`tab-${n}`).props.children)).toEqual(['Home', 'Inbox', 'Activity', 'Settings']);
  });
  it('sends signed-out users to login and unfinished setup to the wizard', async () => {
    reset({ boot: 'ready', session: null });
    const a = await render(<TabsLayout />);
    expect(screen.getByTestId('redirect').props.children).toBe('/(auth)/login');
    await a.unmount();
    reset({ ...signedIn, setupDone: false });
    await render(<TabsLayout />);
    expect(screen.getByTestId('redirect').props.children).toBe('/(setup)/company');
  });
  it('placeholders have clear empty states', async () => {
    await render(<Inbox />);
    expect(screen.getByText('No transactions to classify')).toBeTruthy();
    await render(<Activity />);
    expect(screen.getByText('Nothing processed yet')).toBeTruthy();
  });
});

describe('banners', () => {
  it('Sign in again routes to login', async () => {
    reset({ needsLogin: true });
    await render(<AppBanners />);
    await fireEvent.press(screen.getByRole('button', { name: SIGN_IN_AGAIN }));
    expect(mockPush).toHaveBeenCalledWith('/(auth)/login');
  });
  it('shows the blocking SMS banner when the engine is unusable', async () => {
    reset({ engineUnusable: true });
    await render(<AppBanners />);
    expect(screen.getByText(ENGINE_UNAVAILABLE)).toBeTruthy();
    expect(ENGINE_UNAVAILABLE).toBe('SMS reading is unavailable, update the app');
  });
  it('renders nothing when all is well', async () => {
    await render(<AppBanners />);
    expect(screen.queryByTestId('engine-banner')).toBeNull();
    expect(screen.queryByTestId('login-banner')).toBeNull();
  });
});

describe('settings', () => {
  it('shows site, user, accounts, unread count, engine health; re-runs setup; signs out', async () => {
    reset(signedIn);
    const app = await fakeApp();
    await app.repo.setSetting('unrecognised_count', '3');
    await app.repo.saveMapping({ bankAccount: 'IDFC Credit Card - ZP', glAccount: 'x', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Credit Card' });
    await render(<app.Wrap><Settings /></app.Wrap>);
    expect(screen.getByText('https://atom.example.app')).toBeTruthy();
    expect(screen.getByText('a@b.co')).toBeTruthy();
    expect(await screen.findByText('Messages that could not be read: 3')).toBeTruthy();
    expect(screen.getByText('IDFC Credit Card - ZP')).toBeTruthy();
    expect(screen.getByText('Card, ending 3455, 8129, from IDFCFB')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('SMS reading: Working')).toBeTruthy());
    await fireEvent.press(screen.getByRole('button', { name: 'Run setup again' }));
    expect(mockPush).toHaveBeenCalledWith('/(setup)/company');

    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => void b?.find((x) => x.text === 'Sign out')?.onPress?.());
    await fireEvent.press(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(app.value.signOut).toHaveBeenCalled());
    expect(mockReplace).toHaveBeenCalledWith('/');
    alert.mockRestore();
  });

  it('offers "Grant SMS permission" when SMS is off, requests it and shows the new status', async () => {
    reset(signedIn);
    const app = await fakeApp();
    (app.mocks.hasPermission as jest.Mock).mockResolvedValueOnce({ receive: false, read: false, notifications: true });
    await render(<app.Wrap><Settings /></app.Wrap>);
    expect(await screen.findByText('Not allowed. Bank messages are NOT being read.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Grant SMS permission' }));
    await waitFor(() => expect(screen.getByText('Allowed. Bank messages are being read.')).toBeTruthy());
    expect(app.mocks.requestPermissions).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Grant SMS permission' })).toBeNull();
  });

  it('links the debug receiver in dev builds only', async () => {
    const g = globalThis as { __DEV__?: boolean };
    const app = await fakeApp();
    const a = await render(<app.Wrap><Settings /></app.Wrap>);
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Receiver test (debug)' })).toBeTruthy();
    await a.unmount();
    g.__DEV__ = false;
    try {
      await render(<app.Wrap><Settings /></app.Wrap>);
      await act(async () => undefined);
      expect(screen.queryByRole('button', { name: 'Receiver test (debug)' })).toBeNull();
    } finally {
      g.__DEV__ = true;
    }
  });
});

describe('debug receiver screen', () => {
  it('is unreachable in release builds (redirects away, raw SMS never rendered)', async () => {
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      await render(<DebugReceiver />);
      expect(screen.getByTestId('redirect').props.children).toBe('/');
      expect(screen.queryByText('Peek queue')).toBeNull();
    } finally {
      g.__DEV__ = true;
    }
  });
  it('renders in dev builds', async () => {
    await render(<DebugReceiver />);
    expect(screen.getByText('Peek queue')).toBeTruthy();
  });
});
