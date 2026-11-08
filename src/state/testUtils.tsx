// Test-only helpers: a fake app context backed by an in-memory Repo and a fake native bridge.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { AppContext, type AppContextValue } from './AppProvider';
import type { SmsNative } from './native';

export function fakeNative(over: Partial<Record<keyof SmsNative, unknown>> = {}) {
  const calls: string[] = [];
  const rec = <T,>(name: string, v: T) => jest.fn(async () => { calls.push(name); return v; });
  const n = {
    requestPermissions: rec('requestPermissions', undefined),
    hasPermission: rec('hasPermission', { receive: true, read: true, notifications: true }),
    setSenderPatterns: rec('setSenderPatterns', undefined),
    getSenderPatterns: rec('getSenderPatterns', [] as string[]),
    engineHealth: rec('engineHealth', { usable: true, reason: 'ok' }),
    getTemplatesInfo: rec('getTemplatesInfo', { source: 'bundled', version: 1 }),
    setTemplates: rec('setTemplates', true),
    resetTemplates: rec('resetTemplates', undefined),
    peek: rec('peek', []),
    ack: rec('ack', undefined),
    droppedCount: rec('droppedCount', 0),
    backfill: rec('backfill', []),
    ...over,
  };
  return { native: n as unknown as SmsNative, calls, mocks: n };
}

export async function fakeApp(over: Partial<AppContextValue> = {}) {
  const repo: Repo = await createRepo(createTestDriver());
  const { native, calls, mocks } = fakeNative();
  const value: AppContextValue = {
    repo,
    native,
    client: null,
    signIn: jest.fn(async () => undefined),
    signOut: jest.fn(async () => undefined),
    completeSetup: jest.fn(async () => undefined),
    runCycle: jest.fn(async () => undefined),
    ...over,
  };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Wrap = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <AppContext.Provider value={value}>{children}</AppContext.Provider>
    </QueryClientProvider>
  );
  return { value, repo, Wrap, calls, mocks };
}
