import { KeyGenerationNotPermitted, TwoFactorRequired, RotateDeclined, loadSession, login, loginWithKeys, saveSession } from './auth';
import { ErpAuthError } from './client';

const PASSWORD = 'hunter2-very-secret';
type Route = { status: number; body: unknown };

function router(routes: Record<string, Route>) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key].body), { status: routes[key].status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = {
  '/api/method/login': { status: 200, body: { message: 'Logged In' } },
  '/api/resource/User/': {
    status: 200,
    body: { data: { name: 'a@b.com', api_key: null, roles: [{ role: 'Accounts User' }, { role: 'System Manager' }] } },
  },
  generate_keys: { status: 200, body: { message: { api_key: 'K1', api_secret: 'S1' } } },
};
const args = (impl: typeof fetch, confirmRotate = async () => true) => ({
  siteUrl: 'https://x.example',
  username: 'a@b.com',
  password: PASSWORD,
  confirmRotate,
  fetchImpl: impl,
});

describe('login', () => {
  it('mints keys without asking when no api_key exists', async () => {
    const { impl, calls } = router(base);
    const confirm = jest.fn(async () => true);
    const s = await login(args(impl, confirm));
    expect(confirm).not.toHaveBeenCalled();
    expect(s).toEqual({
      siteUrl: 'https://x.example',
      apiKey: 'K1',
      apiSecret: 'S1',
      user: 'a@b.com',
      roles: ['Accounts User', 'System Manager'],
    });
    expect(calls.some((c) => c.url.includes('generate_keys'))).toBe(true);
  });
  it('asks to rotate when an api_key exists; false -> no generate_keys', async () => {
    const { impl, calls } = router({
      ...base,
      '/api/resource/User/': { status: 200, body: { data: { api_key: 'OLD', roles: [] } } },
    });
    const confirm = jest.fn(async () => false);
    await expect(login(args(impl, confirm))).rejects.toBeInstanceOf(RotateDeclined);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.url.includes('generate_keys'))).toBe(false);
  });
  it('rotates when confirmed', async () => {
    const { impl } = router({
      ...base,
      '/api/resource/User/': { status: 200, body: { data: { api_key: 'OLD', roles: [] } } },
    });
    const s = await login(args(impl, async () => true));
    expect(s.apiKey).toBe('K1');
  });
  it('403 on generate_keys -> KeyGenerationNotPermitted', async () => {
    const { impl } = router({ ...base, generate_keys: { status: 403, body: { exc_type: 'PermissionError' } } });
    await expect(login(args(impl))).rejects.toBeInstanceOf(KeyGenerationNotPermitted);
  });
  it('wrong password (401) -> ErpAuthError', async () => {
    const { impl } = router({ ...base, '/api/method/login': { status: 401, body: { message: 'Invalid login credentials', exc_type: 'AuthenticationError' } } });
    await expect(login(args(impl))).rejects.toBeInstanceOf(ErpAuthError);
  });
  it('2FA response -> TwoFactorRequired', async () => {
    const { impl } = router({
      ...base,
      '/api/method/login': { status: 200, body: { verification: { method: 'OTP App' }, tmp_id: 't' } },
    });
    await expect(login(args(impl))).rejects.toBeInstanceOf(TwoFactorRequired);
  });
  it('password only goes to the login call and never into errors', async () => {
    const { impl, calls } = router({ ...base, generate_keys: { status: 403, body: {} } });
    const e = await login(args(impl)).catch((x): any => x);
    expect(String(e.message)).not.toContain(PASSWORD);
    const withPwd = calls.filter((c) => c.body?.includes(PASSWORD));
    expect(withPwd).toHaveLength(1);
    expect(withPwd[0].url).toContain('/api/method/login');
  });
});

describe('loginWithKeys', () => {
  it('verifies via get_logged_user and returns a session', async () => {
    const { impl, calls } = router({
      get_logged_user: { status: 200, body: { message: 'a@b.com' } },
      '/api/resource/User/': { status: 200, body: { data: { roles: [{ role: 'Accounts User' }] } } },
    });
    const s = await loginWithKeys({ siteUrl: 'https://x.example', apiKey: 'K', apiSecret: 'S', fetchImpl: impl } as never);
    expect(s).toEqual({ siteUrl: 'https://x.example', apiKey: 'K', apiSecret: 'S', user: 'a@b.com', roles: ['Accounts User'] });
    expect(calls[0].url).toContain('get_logged_user');
  });
  it('falls back to empty roles when the user doc is unreadable', async () => {
    const { impl } = router({
      get_logged_user: { status: 200, body: { message: 'a@b.com' } },
      '/api/resource/User/': { status: 403, body: { exc_type: 'PermissionError' } },
    });
    const s = await loginWithKeys({ siteUrl: 'https://x.example', apiKey: 'K', apiSecret: 'S', fetchImpl: impl } as never);
    expect(s.roles).toEqual([]);
  });
  it('bad pair -> ErpAuthError', async () => {
    const { impl } = router({ get_logged_user: { status: 401, body: { exc_type: 'AuthenticationError' } } });
    await expect(
      loginWithKeys({ siteUrl: 'https://x.example', apiKey: 'K', apiSecret: 'S', fetchImpl: impl } as never),
    ).rejects.toBeInstanceOf(ErpAuthError);
  });
});

describe('session persistence', () => {
  it('round-trips and never sees the password', async () => {
    const written: Record<string, string> = {};
    const store = {
      setItem: jest.fn(async (k: string, v: string) => void (written[k] = v)),
      getItem: async (k: string) => written[k] ?? null,
    };
    const { impl } = router(base);
    const s = await login(args(impl));
    await saveSession(s, store);
    expect(JSON.stringify(store.setItem.mock.calls)).not.toContain(PASSWORD);
    expect(await loadSession(store)).toEqual(s);
  });
  it('loadSession returns null when empty or corrupt', async () => {
    expect(await loadSession({ getItem: async () => null })).toBeNull();
    expect(await loadSession({ getItem: async () => '{nope' })).toBeNull();
    expect(await loadSession({ getItem: async () => '{"siteUrl":1}' })).toBeNull();
  });
});
