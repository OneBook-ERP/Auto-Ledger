import {
  ErpAuthError,
  ErpClient,
  ErpNetworkError,
  ErpValidationError,
  encodeSegment,
  normalizeSiteUrl,
} from './client';

type Reply = { status: number; body?: unknown; raw?: string };

function mockFetch(reply: Reply | Error) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (reply instanceof Error) throw reply;
    const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
    return new Response(text, { status: reply.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const KEY = 'abc123key';
const SECRET = 'sup3rs3cret';
function client(reply: Reply | Error) {
  const m = mockFetch(reply);
  return {
    c: new ErpClient({ siteUrl: 'https://x.example', apiKey: KEY, apiSecret: SECRET, fetchImpl: m.impl }),
    calls: m.calls,
  };
}
const sm = (...msgs: object[]) => JSON.stringify(msgs.map((m) => JSON.stringify(m)));

describe('normalizeSiteUrl', () => {
  it('adds https and strips the path', () => {
    expect(normalizeSiteUrl('stageatom.onebook.app/app', { allowHttp: false })).toBe(
      'https://stageatom.onebook.app',
    );
  });
  it('rejects http unless allowed', () => {
    expect(() => normalizeSiteUrl('http://x', { allowHttp: false })).toThrow();
    expect(normalizeSiteUrl('http://x', { allowHttp: true })).toBe('http://x');
  });
  it('rejects empty input', () => {
    expect(() => normalizeSiteUrl('  ', { allowHttp: false })).toThrow();
  });
});

describe('ErpClient requests', () => {
  it('sends the token header and JSON-encodes params', async () => {
    const { c, calls } = client({ status: 200, body: { data: [1] } });
    const r = await c.get<{ data: number[] }>(`/api/resource/${encodeSegment('Payment Entry')}`, {
      fields: ['name'],
      limit_page_length: 5,
    });
    expect(r.data).toEqual([1]);
    expect(calls[0].url).toBe(
      'https://x.example/api/resource/Payment%20Entry?fields=%5B%22name%22%5D&limit_page_length=5',
    );
    expect(calls[0].init.credentials).toBe('omit');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`token ${KEY}:${SECRET}`);
  });
  it('treats 200 create and 202 delete as success', async () => {
    expect(await client({ status: 200, body: { data: { name: 'A' } } }).c.post('/api/resource/X', {})).toEqual({
      data: { name: 'A' },
    });
    await expect(client({ status: 202, body: { data: 'ok' } }).c.delete('/api/resource/X/A')).resolves.toBeUndefined();
  });
  it('call() posts to /api/method and unwraps message', async () => {
    const { c, calls } = client({ status: 200, body: { message: 'u@x.com' } });
    expect(await c.call<string>('frappe.auth.get_logged_user')).toBe('u@x.com');
    expect(calls[0].url).toBe('https://x.example/api/method/frappe.auth.get_logged_user');
  });
});

describe('ErpClient errors', () => {
  it('401 -> ErpAuthError', async () => {
    const { c } = client({ status: 401, body: { exc_type: 'AuthenticationError' } });
    await expect(c.get('/api/x')).rejects.toBeInstanceOf(ErpAuthError);
    await expect(c.get('/api/x')).rejects.toMatchObject({ status: 401 });
  });
  it('403 with doctype in message -> deniedDoctype', async () => {
    const { c } = client({
      status: 403,
      body: {
        exc_type: 'PermissionError',
        _server_messages: sm({
          message:
            'User <strong>x@example.com</strong> does not have doctype access via role permission for document <strong>Supplier</strong>',
        }),
      },
    });
    const e = await c.post<any>('/api/resource/Supplier', {}).catch((x) => x as any);
    expect(e).toBeInstanceOf(ErpAuthError);
    expect(e.deniedDoctype).toBe('Supplier');
    expect(e.status).toBe(403);
  });
  it('403 deniedDoctype from Insufficient Permission and from _error_message', async () => {
    const a = await client({
      status: 403,
      body: { _server_messages: sm({ message: 'Insufficient Permission for <strong>Payment Entry</strong>' }) },
    }).c.get<any>('/x').catch((x) => x as any);
    expect(a.deniedDoctype).toBe('Payment Entry');
    const b = await client({ status: 403, body: { _error_message: 'No permission for Supplier' } }).c
      .get<any>('/x')
      .catch((x) => x as any);
    expect(b.deniedDoctype).toBe('Supplier');
  });
  it('403 with no message -> ErpAuthError without deniedDoctype', async () => {
    const e = await client({ status: 403, body: { exc_type: 'PermissionError' } }).c.get<any>('/x').catch((x) => x as any);
    expect(e).toBeInstanceOf(ErpAuthError);
    expect(e.deniedDoctype).toBeUndefined();
    expect(e.status).toBe(403);
  });
  it('417 Mandatory fields required -> missingFields', async () => {
    const e = await client({
      status: 417,
      body: {
        exc_type: 'MandatoryError',
        _server_messages: sm({ message: 'Mandatory fields required in Employee: Gender' }),
      },
    }).c.post<any>('/api/resource/Employee', {}).catch((x) => x as any);
    expect(e).toBeInstanceOf(ErpValidationError);
    expect(e.missingFields).toEqual(['Gender']);
  });
  it('417 one "Value missing" message per field', async () => {
    const e = await client({
      status: 417,
      body: {
        exc_type: 'MandatoryError',
        _server_messages: sm(
          { message: 'Error: Value missing for Employee: Gender' },
          { message: 'Error: Value missing for Employee: Date of Birth' },
        ),
      },
    }).c.post<any>('/x', {}).catch((x) => x as any);
    expect(e.missingFields).toEqual(['Gender', 'Date of Birth']);
  });
  it('417 ClosedAccountingPeriod -> closedPeriod', async () => {
    const e = await client({
      status: 417,
      body: {
        exc_type: 'ClosedAccountingPeriod',
        exception: 'x.ClosedAccountingPeriod: You cannot create a Payment Entry within the closed Accounting Period <strong>X - ZP</strong>',
        _server_messages: sm({ message: 'You cannot create a Payment Entry within the closed Accounting Period <strong>X - ZP</strong>' }),
      },
    }).c.post<any>('/x', {}).catch((x) => x as any);
    expect(e).toBeInstanceOf(ErpValidationError);
    expect(e.closedPeriod).toBe(true);
    expect(e.message).not.toMatch(/<strong>/);
  });
  it('plain ValidationError keeps stripped message and no flags', async () => {
    const e = await client({
      status: 417,
      body: { exc_type: 'ValidationError', _server_messages: sm({ message: 'Party Type is mandatory' }) },
    }).c.post<any>('/x', {}).catch((x) => x as any);
    expect(e.message).toBe('Party Type is mandatory');
    expect(e.closedPeriod).toBeFalsy();
    expect(e.missingFields).toBeUndefined();
  });
  it('400 and 422 -> ErpValidationError', async () => {
    for (const status of [400, 422]) {
      await expect(client({ status, body: {} }).c.post('/x', {})).rejects.toBeInstanceOf(ErpValidationError);
    }
  });
  it('non-JSON 500, JSON 500 and rejected fetch -> ErpNetworkError', async () => {
    await expect(client({ status: 500, raw: '<html>boom</html>' }).c.get('/x')).rejects.toBeInstanceOf(ErpNetworkError);
    await expect(
      client({ status: 500, body: { exc_type: 'AttributeError' } }).c.post('/x', {}),
    ).rejects.toBeInstanceOf(ErpNetworkError);
    await expect(client(new TypeError('Network request failed')).c.get('/x')).rejects.toBeInstanceOf(ErpNetworkError);
  });
  it('never puts key or secret in error messages or console output', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {}),
    );
    const replies: (Reply | Error)[] = [
      { status: 401, body: { exc_type: 'AuthenticationError' } },
      { status: 500, raw: `echo token ${KEY}:${SECRET}` },
      new Error(`failed with token ${KEY}:${SECRET}`),
    ];
    for (const r of replies) {
      const e = await client(r).c.get<any>('/x').catch((x) => x as any);
      expect(String(e.message)).not.toContain(KEY);
      expect(String(e.message)).not.toContain(SECRET);
      expect(JSON.stringify(e)).not.toContain(SECRET);
    }
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
      s.mockRestore();
    }
  });
});

describe('encoding, https, empty and malformed bodies', () => {
  it('does not re-encode caller-built paths', async () => {
    const { c, calls } = client({ status: 200, body: { data: {} } });
    await c.get(`/api/resource/User/${encodeSegment('a+b@x.com')}`);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://x.example/api/resource/User/a%2Bb%40x.com');
  });
  it('constructor enforces https unless allowHttp', () => {
    const o = { siteUrl: 'http://x.example', apiKey: 'k', apiSecret: 's' };
    expect(() => new ErpClient(o)).toThrow();
    expect(() => new ErpClient({ ...o, allowHttp: true })).not.toThrow();
  });
  it('credentials omit on post, delete and call too', async () => {
    const { c, calls } = client({ status: 200, body: { message: 1 } });
    await c.post('/x', {});
    await c.delete('/x');
    await c.call('m');
    expect(calls.map((x) => x.init.credentials)).toEqual(['omit', 'omit', 'omit']);
  });
  it('empty 2xx: post and delete tolerate, get and call throw ErpNetworkError', async () => {
    const e = () => client({ status: 200, raw: '' }).c;
    await expect(e().post('/x', {})).resolves.toBeUndefined();
    await expect(e().delete('/x')).resolves.toBeUndefined();
    await expect(e().get('/x')).rejects.toBeInstanceOf(ErpNetworkError);
    await expect(e().call('m')).rejects.toBeInstanceOf(ErpNetworkError);
    await expect(client({ status: 200, body: {} }).c.call('m')).rejects.toThrow('Unexpected response from server');
  });
  it('non-JSON 2xx -> ErpNetworkError', async () => {
    await expect(client({ status: 200, raw: '<html>' }).c.get('/x')).rejects.toBeInstanceOf(ErpNetworkError);
  });
});
