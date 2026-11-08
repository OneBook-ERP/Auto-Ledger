import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert } from 'react-native';
import { fakeApp } from '../src/state/testUtils';
import Login, { ROTATE_MESSAGE, ROTATE_TITLE } from '../app/(auth)/login';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const KEYS = { message: { api_key: 'NEWKEY', api_secret: 'NEWSECRET' } };

function mockSite(user: Record<string, unknown>, opts: { generate?: () => Response; login?: () => Response } = {}) {
  const calls: string[] = [];
  jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
    calls.push(String(url));
    if (url.endsWith('/api/method/login')) return opts.login ? opts.login() : json({ message: 'Logged In' });
    if (url.includes('/api/resource/User/')) return json({ data: user });
    if (url.endsWith('generate_keys')) return opts.generate ? opts.generate() : json(KEYS);
    return json({ message: 'a@b.co' });
  }) as typeof fetch);
  return calls;
}

async function fill(site = 'atom.example.app') {
  await fireEvent.changeText(screen.getByLabelText('Site address'), site);
  await fireEvent.changeText(screen.getByLabelText('Username'), 'a@b.co');
  await fireEvent.changeText(screen.getByLabelText('Password'), 'hunter2-secret');
}
const press = (name: string) => fireEvent.press(screen.getByRole('button', { name }));

beforeEach(() => {
  mockReplace.mockClear();
  jest.restoreAllMocks();
});

describe('login', () => {
  it('warns about replacing the API secret BEFORE generate_keys, and Cancel stops without calling it', async () => {
    const calls = mockSite({ api_key: 'EXISTING', roles: [] });
    let seenAtDialog: string[] = [];
    const alert = jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => {
      seenAtDialog = [...calls];
      buttons?.find((b) => b.text === 'Cancel')?.onPress?.();
    });
    const { Wrap, value } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    await waitFor(() => expect(alert).toHaveBeenCalled());
    const [title, message, buttons] = alert.mock.calls[0];
    expect(title).toBe(ROTATE_TITLE);
    expect(message).toBe(ROTATE_MESSAGE);
    expect(message).toMatch(/replaces the existing API secret/);
    expect(message).toMatch(/break any other integration/);
    expect(message).toMatch(/dedicated "AutoLedger" user/);
    expect(buttons?.map((b) => b.text)).toEqual(['Cancel', 'Continue anyway']);
    expect(seenAtDialog.some((u) => u.endsWith('generate_keys'))).toBe(false);
    await waitFor(() => expect(screen.getByText(/dedicated "AutoLedger" user instead/)).toBeTruthy());
    expect(calls.some((u) => u.endsWith('generate_keys'))).toBe(false);
    expect(value.signIn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password').props.value).toBe(''); // cleared once the call returned
  });

  it('Continue anyway generates keys, saves the session and goes to the gate', async () => {
    const calls = mockSite({ api_key: 'EXISTING', roles: [{ role: 'Accounts User' }] });
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons) => buttons?.find((b) => b.text === 'Continue anyway')?.onPress?.());
    const { Wrap, value } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    await waitFor(() => expect(value.signIn).toHaveBeenCalled());
    expect(calls.some((u) => u.endsWith('generate_keys'))).toBe(true);
    expect(mockReplace).toHaveBeenCalledWith('/');
    expect(JSON.stringify((value.signIn as jest.Mock).mock.calls)).not.toContain('hunter2');
  });

  it('a user without a key signs in with no warning', async () => {
    mockSite({ roles: [] });
    const alert = jest.spyOn(Alert, 'alert');
    const { Wrap, value } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    await waitFor(() => expect(value.signIn).toHaveBeenCalled());
    expect(alert).not.toHaveBeenCalled();
  });

  it('two-factor response gives an actionable message and offers the API key path', async () => {
    mockSite({}, { login: () => json({ message: { verification: { method: 'OTP' }, tmp_id: 't' } }) });
    const { Wrap } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    expect(await screen.findByText('This account uses two-factor sign-in, which password sign-in does not support. Sign in with an API key instead.')).toBeTruthy();
    await press('Sign in with an API key instead');
    expect(screen.getByLabelText('API key')).toBeTruthy();
  });

  it('403 on generate_keys shows the paste-key form; loginWithKeys saves the session without roles or password', async () => {
    const calls = mockSite({ roles: [] }, { generate: () => json({ exc_type: 'PermissionError' }, 403) });
    const { Wrap, value } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    expect(await screen.findByLabelText('API key')).toBeTruthy();
    expect(screen.getAllByText(/API Access/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Password')).toBeNull();
    // paste keys
    calls.length = 0;
    jest.spyOn(globalThis, 'fetch').mockImplementation((async (url: string) => {
      if (String(url).includes('get_logged_user')) return json({ message: 'a@b.co' });
      return json({ data: { roles: [{ role: 'System Manager' }] } });
    }) as typeof fetch);
    await fireEvent.changeText(screen.getByLabelText('API key'), 'PASTEDKEY');
    await fireEvent.changeText(screen.getByLabelText('API secret'), 'PASTEDSECRET');
    await press('Sign in');
    await waitFor(() => expect(value.signIn).toHaveBeenCalled());
    const saved = (value.signIn as jest.Mock).mock.calls[0][0];
    expect(saved).toMatchObject({ apiKey: 'PASTEDKEY', apiSecret: 'PASTEDSECRET', user: 'a@b.co' });
    expect(JSON.stringify(saved)).not.toContain('hunter2');
    expect(saved).not.toHaveProperty('password');
  });

  it('wrong credentials and unreachable site get plain messages', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'Incorrect' }, 401));
    const { Wrap } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    await fill();
    await press('Sign in');
    expect(await screen.findByText('Wrong username or password, or this user has no permission to sign in.')).toBeTruthy();
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network request failed'));
    await fireEvent.changeText(screen.getByLabelText('Password'), 'hunter2-secret');
    await press('Sign in');
    await act(async () => undefined);
    expect(await screen.findByText('Cannot reach the site. Check the address and your internet connection.')).toBeTruthy();
  });

  it('rejects http:// in a release build with a clear message and no request', async () => {
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      const f = jest.spyOn(globalThis, 'fetch');
      const { Wrap } = await fakeApp();
      await render(<Wrap><Login /></Wrap>);
      await fill('http://atom.example.app');
      await press('Sign in');
      expect(await screen.findByText('Use an https:// address. Plain http:// is only allowed in test builds.')).toBeTruthy();
      expect(f).not.toHaveBeenCalled();
    } finally {
      g.__DEV__ = true;
    }
  });

  it('has accessible, correctly configured fields', async () => {
    const { Wrap } = await fakeApp();
    await render(<Wrap><Login /></Wrap>);
    const site = screen.getByLabelText('Site address');
    expect(site.props).toMatchObject({ keyboardType: 'url', autoCapitalize: 'none', autoCorrect: false });
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
    await press('Show password');
    expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(false);
  });
});
