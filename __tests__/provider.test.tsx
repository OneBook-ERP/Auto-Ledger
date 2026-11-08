import { act, render, waitFor } from '@testing-library/react-native';
import { AppState, Text } from 'react-native';
import { createRepo } from '../src/data/repo';
import { createTestDriver } from '../src/data/testDriver';
import { resetAppRepoForTests } from '../src/state/appRepo';
import { AppProvider, useApp, type AppContextValue } from '../src/state/AppProvider';
import { fakeNative } from '../src/state/testUtils';
import { useUiStore } from '../src/state/store';

const mockMem = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockMem.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockMem.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockMem.delete(k)),
}));
const mockCycle = jest.fn();
jest.mock('../src/ingest/pipeline', () => ({
  ...jest.requireActual('../src/ingest/pipeline'),
  runForegroundCycle: (...a: unknown[]) => mockCycle(...a),
}));

const SAVED = { siteUrl: 'https://atom.example.app', apiKey: 'K', apiSecret: 'S', user: 'a@b.co', roles: [] };
let appState: ((s: string) => void)[] = [];
let ctx: AppContextValue | null = null;
const Probe = () => {
  ctx = useApp();
  return <Text>ready</Text>;
};

// One shared in-memory driver per test, so a remount sees the same data (like the real single connection).
let driver = createTestDriver();
const open = jest.fn(async () => driver);

const mount = (props: Partial<React.ComponentProps<typeof AppProvider>> = {}, native = fakeNative().native) =>
  render(<AppProvider openDriver={open} native={native} templatesUrl="" {...props}><Probe /></AppProvider>);

beforeEach(() => {
  mockMem.clear();
  mockCycle.mockReset().mockResolvedValue({ failedSteps: [] });
  appState = [];
  ctx = null;
  driver = createTestDriver();
  open.mockClear();
  resetAppRepoForTests();
  useUiStore.setState(useUiStore.getInitialState());
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, cb: (s: string) => void) => {
    appState.push(cb);
    return { remove: jest.fn() };
  }) as never);
});

const signedInDone = async () => {
  mockMem.set('autoledger.session', JSON.stringify(SAVED));
  const r = await createRepo(driver);
  await r.setSetting('setupDone', '1');
  await r.setSetting('site_url', SAVED.siteUrl); // recorded when setup completed
};

const MAP = { bankAccount: 'IDFC', glAccount: 'IDFC - ZP', kind: 'bank' as const, senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Wire Transfer' };
const PEND = { id: 't1', mergedCount: 1, state: 'new' as const, createdDocs: [], error: null, kind: 'ca_credit' as const, direction: 'in' as const, amountMinor: 100, currency: 'INR', occurredOn: '2026-01-02', occurredTime: null, accountType: 'bank' as const, accountLast4: '6507', counterparty: null, utr: null, merchant: null, balanceMinor: null, sender: 'AX-IDFCFB', receivedAt: 1, rawHash: 'h1' };
const OP = { id: 'o1', txnId: 't1', plan: { steps: [], summary: [], needsInrAmount: false }, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' as const };
/** Site A's leftovers: a mapping, a txn and a queued outbox item. */
const seedA = async () => {
  const r = await createRepo(driver);
  await r.saveMapping(MAP);
  await r.upsertPending(PEND);
  await r.enqueue(OP);
  await r.setSetting('company', 'A Co');
};

describe('AppProvider', () => {
  it('boots signed out when nothing is saved, without running a cycle', async () => {
    await mount();
    await waitFor(() => expect(useUiStore.getState().boot).toBe('ready'));
    expect(useUiStore.getState().session).toBeNull();
    expect(mockCycle).not.toHaveBeenCalled();
  });

  it('runs the cycle at start and on AppState active, never overlapping', async () => {
    await signedInDone();
    let release!: () => void;
    mockCycle.mockImplementationOnce(() => new Promise((r) => (release = () => r({ failedSteps: [] }))));
    await mount();
    await waitFor(() => expect(mockCycle).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(appState.length).toBeGreaterThan(0));
    const fire = (s: string) => appState.forEach((cb) => cb(s));
    await act(async () => { fire('active'); fire('active'); });
    expect(mockCycle).toHaveBeenCalledTimes(1); // still the first, in flight
    await act(async () => { release(); });
    await act(async () => { fire('background'); });
    expect(mockCycle).toHaveBeenCalledTimes(1);
    await act(async () => { fire('active'); });
    await waitFor(() => expect(mockCycle).toHaveBeenCalledTimes(2));
    // the cycle receives the one shared repo and the stored session's ErpOps
    const deps = mockCycle.mock.calls[0][0];
    expect(deps.repo).toBe(ctx!.repo);
    expect(typeof deps.erp.checkSession).toBe('function');
  });

  it('creates the Repo once even when the provider remounts', async () => {
    const a = await mount();
    await waitFor(() => expect(ctx).not.toBeNull());
    const first = ctx!.repo;
    await a.unmount();
    ctx = null;
    await mount();
    await waitFor(() => expect(ctx).not.toBeNull());
    expect(ctx!.repo).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('surfaces needs_login_since and an unusable SMS engine as banners after a cycle', async () => {
    await signedInDone();
    const { native, mocks } = fakeNative();
    (mocks.engineHealth as jest.Mock).mockResolvedValue({ usable: false, reason: 'x' });
    mockCycle.mockImplementation(async (deps: { repo: { setSetting(k: string, v: string): Promise<void> } }) => {
      await deps.repo.setSetting('needs_login_since', '123');
      return { failedSteps: [] };
    });
    await mount({}, native);
    await waitFor(() => expect(useUiStore.getState().needsLogin).toBe(true));
    await waitFor(() => expect(useUiStore.getState().engineUnusable).toBe(true));
  });

  it('signIn stores the session without roles, clears the sign-in-again flag and never keeps a password', async () => {
    await mount();
    await waitFor(() => expect(ctx).not.toBeNull());
    await ctx!.repo.setSetting('needs_login_since', '99');
    await act(async () => {
      await ctx!.signIn({ ...SAVED, roles: ['System Manager'], password: 'pw123' } as never);
    });
    const raw = mockMem.get('autoledger.session')!;
    expect(JSON.parse(raw).roles).toEqual([]);
    expect(raw).not.toContain('pw123');
    expect(useUiStore.getState().session).toEqual({ siteUrl: SAVED.siteUrl, user: SAVED.user });
    expect(JSON.stringify(useUiStore.getState())).not.toMatch(/pw123|"S"|apiSecret/);
    expect(await ctx!.repo.getSetting('needs_login_since')).toBe('');
  });

  it('previewSiteSwitch counts the queued actions of the saved site', async () => {
    await signedInDone();
    await seedA();
    await mount();
    await waitFor(() => expect(ctx).not.toBeNull());
    expect(await ctx!.previewSiteSwitch(SAVED.siteUrl)).toEqual({ switching: false, queuedActions: 0 });
    expect(await ctx!.previewSiteSwitch('https://other.example.app')).toEqual({ switching: true, queuedActions: 1 });
  });

  it('signing in to a different site wipes the old site data and restarts setup', async () => {
    await signedInDone();
    await seedA();
    await mount();
    await waitFor(() => expect(useUiStore.getState().setupDone).toBe(true));
    await act(async () => { await ctx!.signIn({ ...SAVED, siteUrl: 'https://other.example.app' }); });
    expect(useUiStore.getState().setupDone).toBe(false);
    expect(await ctx!.repo.listMappings()).toEqual([]);
    expect(await ctx!.repo.nextOutbox()).toBeNull();
    expect(await ctx!.repo.getSetting('company')).toBeNull();
    expect(await ctx!.repo.getSetting('setupDone')).toBeNull();
    expect(await ctx!.repo.getSetting('site_url')).toBe('https://other.example.app');
  });

  it('signing in again to the SAME site keeps mappings, settings and the outbox', async () => {
    await signedInDone();
    await seedA();
    await mount();
    await waitFor(() => expect(useUiStore.getState().setupDone).toBe(true));
    await act(async () => { await ctx!.signIn({ ...SAVED, apiKey: 'NEWKEY' }); });
    expect(useUiStore.getState().setupDone).toBe(true);
    expect(await ctx!.repo.listMappings()).toEqual([MAP]);
    expect((await ctx!.repo.nextOutbox())?.id).toBe('o1');
    expect(await ctx!.repo.getSetting('company')).toBe('A Co');
  });

  it('never runs a cycle when the saved site differs from the session site (site A outbox is not posted to site B)', async () => {
    await signedInDone();
    await seedA();
    await (await createRepo(driver)).setSetting('site_url', 'https://site-a.example.app'); // data of A, session of B
    const actual = jest.requireActual('../src/ingest/pipeline');
    mockCycle.mockImplementation(actual.runForegroundCycle);
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    await mount({ fetchImpl: fetchImpl as never });
    await waitFor(() => expect(useUiStore.getState().boot).toBe('ready'));
    await act(async () => { await ctx!.runCycle(); });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await ctx!.repo.nextOutbox())?.id).toBe('o1'); // still queued, untouched
    expect(await ctx!.repo.getSetting('needs_login_since')).toBeNull();
  });

  it('clears the query cache on sign-in and sign-out', async () => {
    const { useQueryClient } = require('@tanstack/react-query');
    let qc: import('@tanstack/react-query').QueryClient | null = null;
    const QProbe = () => { qc = useQueryClient(); return null; };
    await render(<AppProvider openDriver={open} native={fakeNative().native} templatesUrl=""><Probe /><QProbe /></AppProvider>);
    await waitFor(() => expect(qc).not.toBeNull());
    qc!.setQueryData(['companies', 'https://a'], [{ name: 'A Co' }]);
    await act(async () => { await ctx!.signIn(SAVED); });
    expect(qc!.getQueryData(['companies', 'https://a'])).toBeUndefined();
    qc!.setQueryData(['companies', 'https://a'], [{ name: 'A Co' }]);
    await act(async () => { await ctx!.signOut(); });
    expect(qc!.getQueryData(['companies', 'https://a'])).toBeUndefined();
  });

  it('signOut forgets the credentials but keeps local data', async () => {
    await signedInDone();
    await mount();
    await waitFor(() => expect(useUiStore.getState().session).not.toBeNull());
    await act(async () => { await ctx!.signOut(); });
    expect(mockMem.has('autoledger.session')).toBe(false);
    expect(useUiStore.getState().session).toBeNull();
    expect(await ctx!.repo.getSetting('setupDone')).toBe('1');
  });

  it('signOut asks the site to end the cookie session, best effort, without waiting for it', async () => {
    await signedInDone();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = jest.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Promise<Response>(() => undefined); // the site never answers
    }) as unknown as typeof fetch;
    await mount({ fetchImpl });
    await waitFor(() => expect(useUiStore.getState().session).not.toBeNull());
    await act(async () => { await ctx!.signOut(); });
    expect(useUiStore.getState().session).toBeNull();
    expect(mockMem.has('autoledger.session')).toBe(false);
    const logout = calls.filter((c) => c.url === `${SAVED.siteUrl}/api/method/logout`);
    expect(logout).toHaveLength(1);
    expect(logout[0].init).toMatchObject({ method: 'POST', credentials: 'include' });
  });

  it('signOut completes when the logout call fails', async () => {
    await signedInDone();
    const fetchImpl = jest.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    await mount({ fetchImpl });
    await waitFor(() => expect(useUiStore.getState().session).not.toBeNull());
    await act(async () => { await ctx!.signOut(); });
    expect(useUiStore.getState().session).toBeNull();
    expect(mockMem.has('autoledger.session')).toBe(false);
  });

  it('skips template refresh silently when TEMPLATES_URL is empty', async () => {
    await signedInDone();
    const fetchImpl = jest.fn();
    await mount({ fetchImpl: fetchImpl as never });
    await waitFor(() => expect(mockCycle).toHaveBeenCalled());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
