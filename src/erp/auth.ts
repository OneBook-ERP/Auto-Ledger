import { ErpAuthError, ErpClient, erpFetch, parseJson } from './client';

export type Session = { siteUrl: string; apiKey: string; apiSecret: string; user: string; roles: string[] };

export class TwoFactorRequired extends Error {
  constructor() {
    super('This account uses two-factor login. Create an API key in ERPNext (User > API Access) and paste it instead.');
    this.name = 'TwoFactorRequired';
  }
}

/** generate_keys is System Manager only (spike B.0 #1): UI should offer "paste API key and secret". */
export class KeyGenerationNotPermitted extends Error {
  constructor() {
    super('Your ERPNext user is not allowed to create API keys. Ask an administrator for a key, or sign in as a System Manager.');
    this.name = 'KeyGenerationNotPermitted';
  }
}

export class RotateDeclined extends Error {
  constructor() {
    super('Sign-in cancelled: your existing API key was left unchanged.');
    this.name = 'RotateDeclined';
  }
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };
const rolesOf = (doc: { roles?: { role?: string }[] } | undefined): string[] =>
  (doc?.roles ?? []).map((r) => r.role).filter((r): r is string => typeof r === 'string');

/**
 * Password login, then mint an API key pair. The session cookie from /login is relied on to be
 * kept by the platform cookie jar (React Native does this; no CSRF token needed, spike B.2).
 * The password is only ever sent in the login request body.
 */
export async function login(args: {
  siteUrl: string;
  username: string;
  password: string;
  confirmRotate: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<Session> {
  const f = args.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = args.siteUrl.replace(/\/+$/, '');

  const res = await erpFetch(f, `${base}/api/method/login`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ usr: args.username, pwd: args.password }),
  });
  const body = parseJson<{ message?: string; verification?: unknown; tmp_id?: unknown }>(res.text);
  // 2FA shape was NOT verified against a real site (spike B.2). Per Frappe source the body carries
  // a `verification` object and `tmp_id` instead of message "Logged In"; treat anything other than
  // "Logged In" as needing 2FA.
  if (body?.message !== 'Logged In') throw new TwoFactorRequired();

  const userPath = `${base}/api/resource/User/${encodeURIComponent(args.username)}`;
  const doc = parseJson<{ data?: { api_key?: string | null; roles?: { role?: string }[] } }>(
    (await erpFetch(f, userPath, { method: 'GET', headers: JSON_HEADERS })).text,
  ).data;

  if (doc?.api_key) {
    if (!(await args.confirmRotate())) throw new RotateDeclined();
  }

  let keys: { api_key: string; api_secret: string };
  try {
    const r = await erpFetch(f, `${base}/api/method/frappe.core.doctype.user.user.generate_keys`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ user: args.username }),
    });
    keys = parseJson<{ message: { api_key: string; api_secret: string } }>(r.text).message;
  } catch (e) {
    if (e instanceof ErpAuthError && e.status === 403) throw new KeyGenerationNotPermitted();
    throw e;
  }

  return { siteUrl: base, apiKey: keys.api_key, apiSecret: keys.api_secret, user: args.username, roles: rolesOf(doc) };
}

/** Paste-a-key path: verify the pair with frappe.auth.get_logged_user. */
export async function loginWithKeys(args: {
  siteUrl: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<Session> {
  const siteUrl = args.siteUrl.replace(/\/+$/, '');
  const client = new ErpClient({ siteUrl, apiKey: args.apiKey, apiSecret: args.apiSecret, fetchImpl: args.fetchImpl });
  const r = await client.get<{ message: string }>('/api/method/frappe.auth.get_logged_user');
  const user = r.message;
  // Own User doc is readable with the token in the spike; for a restricted user it may be 403, in
  // which case roles are left empty (they are informational only).
  let roles: string[] = [];
  try {
    const d = await client.get<{ data?: { roles?: { role?: string }[] } }>(`/api/resource/User/${encodeURIComponent(user)}`);
    roles = rolesOf(d.data);
  } catch (e) {
    if (!(e instanceof ErpAuthError)) throw e;
  }
  return { siteUrl, apiKey: args.apiKey, apiSecret: args.apiSecret, user, roles };
}

const SESSION_KEY = 'autoledger.session';

export async function saveSession(session: Session, store: { setItem(key: string, value: string): Promise<void> }): Promise<void> {
  await store.setItem(SESSION_KEY, JSON.stringify(session));
}

export async function loadSession(store: { getItem(key: string): Promise<string | null> }): Promise<Session | null> {
  const raw = await store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      typeof s.siteUrl === 'string' && typeof s.apiKey === 'string' && typeof s.apiSecret === 'string' &&
      typeof s.user === 'string' && Array.isArray(s.roles)
    ) {
      return { siteUrl: s.siteUrl, apiKey: s.apiKey, apiSecret: s.apiSecret, user: s.user, roles: s.roles.map(String) };
    }
  } catch {
    // fall through
  }
  return null;
}
