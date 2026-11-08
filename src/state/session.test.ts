import type { Session } from '../erp/auth';

const mockMem = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockMem.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockMem.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockMem.delete(k)),
}));
import * as SecureStore from 'expo-secure-store';
import { clearSession, persistSession, restoreSession, summarize } from './session';

const S: Session = { siteUrl: 'https://atom.example.app', apiKey: 'KEY1', apiSecret: 'SECRET1', user: 'a@b.co', roles: ['System Manager', 'Accounts User'] };

beforeEach(() => mockMem.clear());

describe('session store', () => {
  it('saves under autoledger.session with roles stripped (R31)', async () => {
    await persistSession(S);
    const raw = mockMem.get('autoledger.session')!;
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('autoledger.session', expect.any(String));
    expect(JSON.parse(raw)).toEqual({ siteUrl: S.siteUrl, apiKey: 'KEY1', apiSecret: 'SECRET1', user: 'a@b.co', roles: [] });
    expect(raw).not.toContain('System Manager');
  });
  it('round-trips and never carries roles or a password', async () => {
    await persistSession({ ...S, password: 'hunter2' } as Session);
    expect(mockMem.get('autoledger.session')).not.toContain('hunter2');
    expect(await restoreSession()).toEqual({ ...S, roles: [] });
  });
  it('returns null when nothing is stored, and after clearSession', async () => {
    expect(await restoreSession()).toBeNull();
    await persistSession(S);
    await clearSession();
    expect(await restoreSession()).toBeNull();
  });
  it('summarize exposes only site and user', () => {
    expect(summarize(S)).toEqual({ siteUrl: S.siteUrl, user: 'a@b.co' });
  });
});
