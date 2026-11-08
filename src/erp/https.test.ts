// HTTPS in release (plan Task 20 Step 2). `allowHttp` is `__DEV__` everywhere the app builds a client or
// reads a session (state/erp.ts, state/session.ts, app/(auth)/login.tsx): false in a release build.
//
// Already covered elsewhere and not repeated here: normalizeSiteUrl http/https basics and the ErpClient
// constructor (client.test.ts "normalizeSiteUrl", "constructor enforces https unless allowHttp"), and the
// plain http rejections of login / loginWithKeys / loadSession (auth.test.ts "login enforces https unless
// allowHttp", "loginWithKeys: https enforced", "loadSession re-validates https").
// This file adds: nothing is sent over http (no fetch at all), credentials in the URL are stripped on every
// path, http is accepted on every path in debug, and the release wiring really passes false.
import { loadSession, login, loginWithKeys } from './auth';
import { ErpClient, normalizeSiteUrl } from './client';

const RELEASE = { allowHttp: false };
const DEBUG = { allowHttp: true };

/** Answers like a Frappe site on any host; records every URL. */
function site() {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(url);
    const path = new URL(url).pathname;
    const body =
      path === '/api/method/login' ? { message: 'Logged In' }
        : path.startsWith('/api/resource/User/') ? { data: { name: 'a@b.com', api_key: null, roles: [] } }
          : path.endsWith('generate_keys') ? { message: { api_key: 'K1', api_secret: 'S1' } }
            : path.endsWith('get_logged_user') ? { message: 'a@b.com' }
              : {};
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const loginArgs = (siteUrl: string, fetchImpl: typeof fetch) => ({ siteUrl, username: 'a@b.com', password: 'pw', confirmRotate: async () => true, fetchImpl });
const keyArgs = (siteUrl: string, fetchImpl: typeof fetch) => ({ siteUrl, apiKey: 'K', apiSecret: 'S', fetchImpl });
const stored = (siteUrl: string) => ({ getItem: async () => JSON.stringify({ siteUrl, apiKey: 'k', apiSecret: 's', user: 'u', roles: [] }) });

describe('release (allowHttp false): http:// is refused before anything is sent', () => {
  it.each(['http://erp.example.com', 'HTTP://erp.example.com', 'http://10.0.2.2:8000', 'ftp://erp.example.com'])('%s', async (url) => {
    const { impl, urls } = site();
    expect(() => normalizeSiteUrl(url, RELEASE)).toThrow('Use an https:// address.');
    expect(() => new ErpClient({ siteUrl: url, apiKey: 'k', apiSecret: 's', fetchImpl: impl, ...RELEASE })).toThrow();
    await expect(login({ ...loginArgs(url, impl), ...RELEASE })).rejects.toThrow();
    await expect(loginWithKeys({ ...keyArgs(url, impl), ...RELEASE })).rejects.toThrow();
    expect(await loadSession(stored(url), RELEASE)).toBeNull();
    expect(urls).toEqual([]); // the password and the key never left the phone
  });

  it('the default (allowHttp omitted) is the release value', async () => {
    const { impl, urls } = site();
    expect(() => new ErpClient({ siteUrl: 'http://x.example', apiKey: 'k', apiSecret: 's', fetchImpl: impl })).toThrow();
    await expect(login(loginArgs('http://x.example', impl))).rejects.toThrow();
    await expect(loginWithKeys(keyArgs('http://x.example', impl))).rejects.toThrow();
    expect(await loadSession(stored('http://x.example'))).toBeNull();
    expect(urls).toEqual([]);
  });
});

describe('credentials in the address (https://user:pw@host) are stripped', () => {
  const URL_WITH_PW = 'https://admin:s3cret@erp.example.com:8443/app/home?x=1';
  const CLEAN = 'https://erp.example.com:8443';

  it('normalizeSiteUrl', () => {
    expect(normalizeSiteUrl(URL_WITH_PW, RELEASE)).toBe(CLEAN);
    expect(normalizeSiteUrl('admin:s3cret@erp.example.com', RELEASE)).toBe('https://erp.example.com');
  });

  it('ErpClient, login, loginWithKeys and loadSession never send or keep them', async () => {
    const { impl, urls } = site();
    await new ErpClient({ siteUrl: URL_WITH_PW, apiKey: 'k', apiSecret: 's', fetchImpl: impl }).get('/api/method/ping');
    expect((await login(loginArgs(URL_WITH_PW, impl))).siteUrl).toBe(CLEAN);
    expect((await loginWithKeys(keyArgs(URL_WITH_PW, impl))).siteUrl).toBe(CLEAN);
    expect((await loadSession(stored(URL_WITH_PW)))?.siteUrl).toBe(CLEAN);
    expect(urls.length).toBeGreaterThan(4);
    for (const u of urls) {
      expect(u.startsWith(`${CLEAN}/api/`)).toBe(true);
      expect(u).not.toMatch(/admin|s3cret|@erp/);
    }
  });
});

describe('debug (allowHttp true): http:// is accepted on every path', () => {
  it('normalizeSiteUrl, ErpClient, login, loginWithKeys, loadSession', async () => {
    const { impl, urls } = site();
    const url = 'http://10.0.2.2:8000';
    expect(normalizeSiteUrl(url, DEBUG)).toBe(url);
    await new ErpClient({ siteUrl: url, apiKey: 'k', apiSecret: 's', fetchImpl: impl, ...DEBUG }).get('/api/method/ping');
    expect((await login({ ...loginArgs(url, impl), ...DEBUG })).siteUrl).toBe(url);
    expect((await loginWithKeys({ ...keyArgs(url, impl), ...DEBUG })).siteUrl).toBe(url);
    expect((await loadSession(stored(url), DEBUG))?.siteUrl).toBe(url);
    expect(urls.every((u) => u.startsWith(`${url}/api/`))).toBe(true);
  });
});

describe('release wiring: the app passes __DEV__, which is false in a release build', () => {
  const g = globalThis as { __DEV__?: boolean };
  const dev = g.__DEV__;
  afterEach(() => {
    g.__DEV__ = dev;
    jest.resetModules();
  });

  it('buildErp refuses an http session and restoreSession forgets one when __DEV__ is false', async () => {
    g.__DEV__ = false;
    jest.doMock('expo-secure-store', () => ({
      getItemAsync: async () => JSON.stringify({ siteUrl: 'http://x.example', apiKey: 'k', apiSecret: 's', user: 'u', roles: [] }),
      setItemAsync: async () => undefined,
      deleteItemAsync: async () => undefined,
    }));
    const { buildErp } = require('../state/erp') as typeof import('../state/erp');
    const { restoreSession } = require('../state/session') as typeof import('../state/session');
    const s = { siteUrl: 'http://x.example', apiKey: 'k', apiSecret: 's', user: 'u', roles: [] };
    expect(() => buildErp(s)).toThrow('Use an https:// address.');
    expect(await restoreSession()).toBeNull();
    g.__DEV__ = true;
    expect(() => buildErp(s)).not.toThrow();
    expect((await restoreSession())?.siteUrl).toBe('http://x.example');
  });
});
