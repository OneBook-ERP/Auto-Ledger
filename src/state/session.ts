// Secure session storage. The API key/secret live in the Android Keystore-backed expo-secure-store; the
// password is never stored (login() only passes it to the server). Roles are NOT persisted (R31): they are
// fetched on demand when needed.
import * as SecureStore from 'expo-secure-store';
import { loadSession, saveSession, type Session } from '../erp/auth';
import type { SessionSummary } from './store';

const SESSION_KEY = 'autoledger.session';

const store = {
  getItem: (key: string) => SecureStore.getItemAsync(key),
  setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
};

/** Saves the session without its roles (and without any stray field). */
export async function persistSession(s: Session): Promise<void> {
  await saveSession({ siteUrl: s.siteUrl, apiKey: s.apiKey, apiSecret: s.apiSecret, user: s.user, roles: [] }, store);
}

export const restoreSession = (): Promise<Session | null> => loadSession(store, { allowHttp: __DEV__ });

export async function clearSession(): Promise<void> {
  await SecureStore.deleteItemAsync(SESSION_KEY);
}

export const summarize = (s: Session): SessionSummary => ({ siteUrl: s.siteUrl, user: s.user });
