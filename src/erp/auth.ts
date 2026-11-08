import { ErpAuthError, ErpClient, encodeSegment, erpFetch, normalizeSiteUrl, parseJson, unexpectedResponse } from './client';

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
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const rolesOf = (doc: unknown): string[] => {
  const r = isObj(doc) && Array.isArray(doc.roles) ? doc.roles : [];
  return r.map((x) => (isObj(x) ? x.role : undefined)).filter((x): x is string => typeof x === 'string');
};

/** Password login succeeded but the follow-up session-cookie request was rejected. */
export class SessionCookieMissing extends ErpAuthError {
  constructor(status: number) {
    super('Signed in, but the session cookie was not kept. Try again or paste an API key.', status);
    this.name = 'SessionCookieMissing';
  }
}

/**
 * Password login, then mint an API key pair. The session cookie from /login is relied on to be
 * kept by the platform cookie jar (React Native does this; no CSRF token needed, spike B.2), so
 * these requests use credentials 'include'. The password is only ever sent in the login body.
 */
export async function login(args: {
  siteUrl: string;
  username: string;
  password: string;
  confirmRotate: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
  allowHttp?: boolean;
}): Promise<Session> {
  const f = args.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = normalizeSiteUrl(args.siteUrl, { allowHttp: args.allowHttp ?? false });
  const flow = { headers: JSON_HEADERS, credentials: 'include' as const };

  const res = await erpFetch(f, `${base}/api/method/login`, {
    ...flow,
    method: 'POST',
    body: JSON.stringify({ usr: args.username, pwd: args.password }),
  });
  let body: unknown;
  try {
    body = parseJson<unknown>(res.text);
  } catch {
    throw new ErpAuthError('Unexpected login response', res.status);
  }
  if (!(isObj(body) && body.message === 'Logged In')) {
    // 2FA shape was NOT verified against a real site (spike B.2). Coded defensively on the
    // documented Frappe markers: `verification` / `tmp_id` in the body or in a `message` payload.
    const m = isObj(body) ? body.message : undefined;
    const has = (o: unknown) => isObj(o) && ('verification' in o || 'tmp_id' in o);
    if (has(body) || has(m)) throw new TwoFactorRequired();
    throw new ErpAuthError('Unexpected login response', res.status);
  }

  let doc: unknown;
  try {
    const r = await erpFetch(f, `${base}/api/resource/User/${encodeSegment(args.username)}`, { ...flow, method: 'GET' });
    const parsed = parseJson<unknown>(r.text);
    doc = isObj(parsed) ? parsed.data : undefined;
  } catch (e) {
    if (e instanceof ErpAuthError) throw new SessionCookieMissing(e.status);
    throw e;
  }
  if (!isObj(doc)) throw unexpectedResponse();

  if (doc.api_key) {
    if (!(await args.confirmRotate())) throw new RotateDeclined();
  }

  let keys: unknown;
  try {
    const r = await erpFetch(f, `${base}/api/method/frappe.core.doctype.user.user.generate_keys`, {
      ...flow,
      method: 'POST',
      body: JSON.stringify({ user: args.username }),
    });
    const parsed = parseJson<unknown>(r.text);
    keys = isObj(parsed) ? parsed.message : undefined;
  } catch (e) {
    if (e instanceof ErpAuthError && e.status === 403) throw new KeyGenerationNotPermitted();
    throw e;
  }
  if (!isObj(keys) || typeof keys.api_key !== 'string' || typeof keys.api_secret !== 'string' || !keys.api_key || !keys.api_secret) {
    throw unexpectedResponse();
  }

  return { siteUrl: base, apiKey: keys.api_key, apiSecret: keys.api_secret, user: args.username, roles: rolesOf(doc) };
}

/** Paste-a-key path: verify the pair with frappe.auth.get_logged_user. */
export async function loginWithKeys(args: {
  siteUrl: string;
  apiKey: string;
  apiSecret: string;
  fetchImpl?: typeof fetch;
  allowHttp?: boolean;
}): Promise<Session> {
  const siteUrl = normalizeSiteUrl(args.siteUrl, { allowHttp: args.allowHttp ?? false });
  const client = new ErpClient({ siteUrl, apiKey: args.apiKey, apiSecret: args.apiSecret, fetchImpl: args.fetchImpl, allowHttp: args.allowHttp });
  const r = await client.get<{ message?: unknown }>('/api/method/frappe.auth.get_logged_user');
  const user = r.message;
  if (typeof user !== 'string' || !user) throw unexpectedResponse();
  // Own User doc is readable with the token in the spike; for a restricted user it may be 403, in
  // which case roles are left empty (they are informational only).
  let roles: string[] = [];
  try {
    const d = await client.get<{ data?: unknown }>(`/api/resource/User/${encodeSegment(user)}`);
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

export async function loadSession(
  store: { getItem(key: string): Promise<string | null> },
  opts: { allowHttp?: boolean } = {},
): Promise<Session | null> {
  const raw = await store.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<Session>;
    if (
      typeof s.siteUrl === 'string' && typeof s.apiKey === 'string' && typeof s.apiSecret === 'string' &&
      typeof s.user === 'string' && Array.isArray(s.roles)
    ) {
      return { siteUrl: normalizeSiteUrl(s.siteUrl, { allowHttp: opts.allowHttp ?? false }), apiKey: s.apiKey, apiSecret: s.apiSecret, user: s.user, roles: s.roles.map(String) };
    }
  } catch {
    // fall through
  }
  return null;
}
