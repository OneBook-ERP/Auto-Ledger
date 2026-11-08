// Thin typed ERPNext/Frappe client over global fetch. Contract: docs/spike-report.md section B.
// Security: the Authorization header is the only place the key/secret are used; they are never put
// into error messages or logged.

export class ErpAuthError extends Error {
  // Frappe 403 payloads never name a role (spike B.9), only sometimes a doctype.
  constructor(message: string, readonly status: number, readonly deniedDoctype?: string) {
    super(message);
    this.name = 'ErpAuthError';
  }
}

export class ErpValidationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly missingFields?: string[],
    readonly closedPeriod?: boolean,
  ) {
    super(message);
    this.name = 'ErpValidationError';
  }
}

// fetch rejected, timed out, or the server failed (any 5xx). A 5xx with a JSON body (for example
// the HTTP 500 AttributeError for a Customer without customer_name) is mapped here too: it is a
// server fault, not something the user can fix, and a later layer validates inputs up front.
export class ErpNetworkError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ErpNetworkError';
  }
}

export function normalizeSiteUrl(input: string, opts: { allowHttp: boolean }): string {
  let s = input.trim();
  if (!s) throw new Error('Enter your ERPNext site address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That does not look like a valid site address.');
  }
  if (u.protocol === 'http:' && !opts.allowHttp) throw new Error('Use an https:// address.');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Use an https:// address.');
  return `${u.protocol}//${u.host}`;
}

/** Encode one URL path segment (document names, user ids). ErpClient never re-encodes paths. */
export const encodeSegment = (s: string): string => encodeURIComponent(s);

export const unexpectedResponse = () => new ErpNetworkError('Unexpected response from server');

const stripTags = (s: string) =>
  s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// `_server_messages` is a JSON string of an array of JSON strings, each {message,title,indicator}.
function serverMessages(body: Record<string, unknown>): string[] {
  const raw = body._server_messages;
  if (typeof raw !== 'string') return [];
  try {
    const outer: unknown = JSON.parse(raw);
    if (!Array.isArray(outer)) return [];
    return outer.flatMap((e) => {
      try {
        const m: unknown = typeof e === 'string' ? JSON.parse(e) : e;
        const msg = (m as { message?: unknown })?.message;
        return typeof msg === 'string' ? [msg] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function missingFieldsFrom(messages: string[]): string[] | undefined {
  const out: string[] = [];
  for (const m of messages.map(stripTags)) {
    let r = /Value missing for [^:]+:\s*(.+)$/i.exec(m);
    if (r) {
      out.push(r[1].trim());
      continue;
    }
    r = /Mandatory fields? required[^:]*:\s*(.+)$/i.exec(m);
    if (r) out.push(...r[1].split(',').map((x) => x.trim()).filter(Boolean));
  }
  return out.length ? Array.from(new Set(out)) : undefined;
}

function deniedDoctypeFrom(body: Record<string, unknown>, messages: string[]): string | undefined {
  for (const m of messages) {
    const r = /(?:for document|Insufficient Permission for)\s*<strong>([^<]+)<\/strong>/i.exec(m);
    if (r) return r[1];
  }
  const em = body._error_message;
  if (typeof em === 'string') {
    const r = /No permission for (.+)$/i.exec(em);
    if (r) return r[1].trim();
  }
  return undefined;
}

export function errorFromResponse(status: number, text: string): Error {
  let body: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(text);
    if (p && typeof p === 'object') body = p as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (status >= 500) return new ErpNetworkError(`The ERPNext server had a problem (HTTP ${status}).`, status);
  const b = body ?? {};
  const messages = serverMessages(b);
  const text1 = messages.map(stripTags).find(Boolean) ?? (typeof b.message === 'string' ? stripTags(b.message) : '');
  if (status === 401) return new ErpAuthError('ERPNext did not accept the credentials.', 401);
  if (status === 403) {
    const doctype = deniedDoctypeFrom(b, messages);
    return new ErpAuthError(
      doctype
        ? `Your ERPNext user is not allowed to do this on ${doctype}. Ask your ERPNext administrator for access.`
        : 'Your ERPNext user is not allowed to do this. Ask your ERPNext administrator for access.',
      403,
      doctype,
    );
  }
  const closed = b.exc_type === 'ClosedAccountingPeriod';
  const missing = b.exc_type === 'MandatoryError' || !b.exc_type ? missingFieldsFrom(messages) : undefined;
  const fallback = typeof b.exception === 'string' ? stripTags(b.exception.replace(/^[\w.]+:\s*/, '')) : '';
  return new ErpValidationError(text1 || fallback || `ERPNext rejected the request (HTTP ${status}).`, status, missing, closed || undefined);
}

export async function erpFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs = 30000,
): Promise<{ status: number; text: string }> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl?.signal });
    const text = await res.text();
    if (res.status >= 200 && res.status < 300) return { status: res.status, text };
    throw errorFromResponse(res.status, text);
  } catch (e) {
    if (e instanceof ErpAuthError || e instanceof ErpValidationError || e instanceof ErpNetworkError) throw e;
    // Do not forward the original message: keep error text free of anything request-derived.
    throw new ErpNetworkError('Could not reach the ERPNext site. Check your connection and try again.');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function parseJson<T>(text: string): T {
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ErpNetworkError('ERPNext returned an unreadable response.');
  }
}

export class ErpClient {
  private readonly siteUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { siteUrl: string; apiKey: string; apiSecret: string; fetchImpl?: typeof fetch; allowHttp?: boolean }) {
    this.siteUrl = normalizeSiteUrl(opts.siteUrl, { allowHttp: opts.allowHttp ?? false });
    this.authHeader = `token ${opts.apiKey}:${opts.apiSecret}`;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  private async send<T>(method: string, path: string, params?: Record<string, unknown>, body?: unknown): Promise<T> {
    // Paths are caller-built and already encoded (use encodeSegment for names); never re-encoded here.
    let url = this.siteUrl + path;
    if (params) {
      const q = Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
        .join('&');
      if (q) url += `?${q}`;
    }
    const headers: Record<string, string> = { Authorization: this.authHeader, Accept: 'application/json' };
    // 'omit': token auth only, a stale sid cookie must never be attached.
    const init: RequestInit = { method, headers, credentials: 'omit' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const { text } = await erpFetch(this.fetchImpl, url, init);
    return parseJson<T>(text);
  }

  /** Returns the parsed JSON object body as-is (e.g. `{data: [...]}`). An empty/non-object 2xx body throws ErpNetworkError. */
  async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const r = await this.send<unknown>('GET', path, params);
    if (!r || typeof r !== 'object') throw unexpectedResponse();
    return r as T;
  }

  /** Returns the parsed JSON body (create returns `{data: doc}`); an empty 2xx body is tolerated and yields undefined. */
  post<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('POST', path, undefined, body);
  }

  /** Empty 2xx bodies are fine. */
  async delete(path: string): Promise<void> {
    await this.send<unknown>('DELETE', path);
  }

  /** POST /api/method/<method>; returns the unwrapped `message` field; a missing `message` throws ErpNetworkError. */
  async call<T>(method: string, args?: Record<string, unknown>): Promise<T> {
    const r = await this.send<{ message?: T }>('POST', `/api/method/${method}`, undefined, args ?? {});
    if (!r || typeof r !== 'object' || r.message === undefined || r.message === null) throw unexpectedResponse();
    return r.message;
  }
}
