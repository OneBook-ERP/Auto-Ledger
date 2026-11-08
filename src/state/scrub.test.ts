import { scrubEvent, scrubText } from './scrub';

const SITE_URL = 'https://atom.example.app';
const UTR = 'IDFB6292M4509651';
const SMS = 'Your A/C XXXXXXX6507 is credited by INR 1,23,450.00 on 05-11-26. UTR IDFB6292M4509651. Avl Bal Rs.5,12,932.76';
const EMAIL = 'ravi.kumar@acme-traders.in';
const AUTH = 'token 3f9a1c2b7d:9e8f7a6b5c4d';

/** Every secret that must not survive anywhere in the serialised result. */
const SECRETS = [
  '1,23,450.00', '123450', '5,12,932.76', '51293276', UTR, '6292M4509651', 'XXXXXXX6507', '6507', EMAIL, 'acme-traders', 'ravi.kumar',
  '3f9a1c2b7d', '9e8f7a6b5c4d', 'atom.example.app', 'credited by', 'Avl Bal', 'api_secret_value', 'hunter2', '9876543210', 'sid=abc',
];

function rawEvent(): Record<string, unknown> {
  return {
    event_id: 'c0ffee00c0ffee00c0ffee00c0ffee00',
    timestamp: 1762300000.123,
    platform: 'javascript',
    level: 'error',
    release: 'com.autoledger.app@1.0.0+58',
    environment: 'production',
    sdk: { name: 'sentry.javascript.react-native', version: '7.2.0' },
    message: `Failed to post ₹ 12,345.50 for ${UTR} to ${SITE_URL}/api/resource/Payment%20Entry?filters=[["reference_no","=","${UTR}"]]`,
    exception: {
      values: [{
        type: 'ErpNetworkError',
        value: `Could not reach ${SITE_URL}/api/method/logout for ${EMAIL} (amount Rs 4500, acct 123456789012)`,
        stacktrace: {
          frames: [{
            filename: 'app:///index.android.bundle', function: 'runPlan', lineno: 412, colno: 17, in_app: true,
            vars: { body: SMS, amountMinor: 12345000, utr: UTR, ref: UTR, note: `paid ${'INR 1,23,450.00'}`, apiSecret: 'api_secret_value' },
          }],
        },
      }],
    },
    breadcrumbs: [
      { category: 'console', message: SMS, level: 'log' },
      { category: 'fetch', data: { url: `${SITE_URL}/api/resource/Customer?x=1`, method: 'GET' } },
      { category: 'xhr', data: { url: `${SITE_URL}/api/method/frappe.auth.get_logged_user` } },
      { category: 'navigation', message: `to /txn/${UTR}`, data: { from: '/inbox', to: `/txn/${UTR}` } },
      { category: 'ui.click', message: `Pressed Create for ₹1,23,450.00 ${EMAIL}` },
    ],
    extra: {
      sms: SMS, body: SMS, message: SMS, smsBody: SMS, rawBody: SMS,
      phone: '9876543210', counterparty: 'ACME TRADERS', note: `${EMAIL} paid INR 4,500`, password: 'hunter2',
      nested: { deeper: { url: `${SITE_URL}/app/payment-entry/ACC-PAY-0001?sid=abc`, apiKey: 'k' } },
    },
    contexts: {
      os: { name: 'Android', version: '15' },
      app: { app_name: 'AutoLedger', app_version: '1.0.0' },
      erp: { site: SITE_URL, user: EMAIL },
    },
    request: {
      url: `${SITE_URL}/api/resource/Payment%20Entry?limit=20&sid=abc`,
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json', Cookie: 'sid=abc' },
      data: { reference_no: UTR, paid_amount: 1234.5 },
      cookies: { sid: 'abc' },
      query_string: 'sid=abc',
    },
    user: { id: 'device-1', email: EMAIL, username: 'ravi', ip_address: '10.0.0.1' },
    tags: { site: 'atom.example.app', screen: 'txn', utr: UTR },
  };
}

describe('scrubEvent', () => {
  it('no amount, UTR, SMS body, email, Authorization header or site URL survives anywhere', () => {
    const out = JSON.stringify(scrubEvent(rawEvent()));
    for (const s of SECRETS) expect({ secret: s, found: out.includes(s) }).toEqual({ secret: s, found: false });
    expect(out).not.toMatch(/₹|\bRs\b|\bINR\b/);
    expect(out.replace('"timestamp":1762300000.123', '')).not.toMatch(/\d{6,}/);
    expect(out.toLowerCase()).not.toContain('authorization');
    expect(out).not.toContain('?');
  });

  it('benign fields survive: platform, release, ids, timestamps, exception type, frame file/function/lines', () => {
    const out = scrubEvent(rawEvent()) as any;
    expect(out.event_id).toBe('c0ffee00c0ffee00c0ffee00c0ffee00');
    expect(out.timestamp).toBe(1762300000.123);
    expect(out.platform).toBe('javascript');
    expect(out.level).toBe('error');
    expect(out.release).toBe('com.autoledger.app@1.0.0+58');
    expect(out.environment).toBe('production');
    expect(out.sdk).toEqual({ name: 'sentry.javascript.react-native', version: '7.2.0' });
    expect(out.exception.values[0].type).toBe('ErpNetworkError');
    expect(out.exception.values[0].stacktrace.frames[0]).toMatchObject({ filename: 'app:///index.android.bundle', function: 'runPlan', lineno: 412, colno: 17, in_app: true });
    expect(out.contexts.os).toEqual({ name: 'Android', version: '15' });
    expect(out.contexts.app).toEqual({ app_name: 'AutoLedger', app_version: '1.0.0' });
    expect(out.request.method).toBe('POST');
    expect(out.request.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(out.user).toEqual({ id: 'device-1' });
    expect(out.tags.screen).toBe('txn');
  });

  it('URLs keep scheme and path only, with the host replaced', () => {
    const out = scrubEvent(rawEvent()) as any;
    expect(out.request.url).toBe('https://<site>/api/resource/Payment%20Entry');
    expect(out.message).toContain('https://<site>/api/resource/Payment%20Entry');
    expect(out.exception.values[0].value).toContain('https://<site>/api/method/logout');
  });

  it('drops console/fetch/xhr breadcrumbs, scrubs the rest', () => {
    const out = scrubEvent(rawEvent()) as any;
    expect(out.breadcrumbs.map((b: { category: string }) => b.category)).toEqual(['navigation', 'ui.click']);
    expect(out.breadcrumbs[0].message).toBe('to /txn/<ref>');
    expect(out.breadcrumbs[0].data).toBeUndefined(); // data payloads dropped
    // Sentry's wire format { values: [...] } too.
    const wrapped = scrubEvent({ breadcrumbs: { values: [{ category: 'console', message: 'x' }, { category: 'ui', message: EMAIL }] } }) as any;
    expect(wrapped.breadcrumbs).toEqual({ values: [{ category: 'ui', message: '<email>' }] });
  });

  it('drops body/sms/message-named extra fields and credential-named keys entirely', () => {
    const out = scrubEvent(rawEvent()) as any;
    for (const k of ['sms', 'body', 'message', 'smsBody', 'rawBody', 'password']) expect(out.extra).not.toHaveProperty(k);
    expect(out.extra.nested.deeper).not.toHaveProperty('apiKey');
    expect(out.exception.values[0].stacktrace.frames[0].vars).not.toHaveProperty('body');
    expect(out.exception.values[0].stacktrace.frames[0].vars).not.toHaveProperty('apiSecret');
    expect(out.request).not.toHaveProperty('data');
    expect(out.request).not.toHaveProperty('cookies');
    expect(out.request).not.toHaveProperty('query_string');
  });

  it('is idempotent', () => {
    const once = scrubEvent(rawEvent());
    expect(scrubEvent(once)).toEqual(once);
  });

  it('never mutates its input', () => {
    const e = rawEvent();
    const copy = JSON.parse(JSON.stringify(e));
    scrubEvent(e);
    expect(e).toEqual(copy);
  });

  it('handles circular references and odd input without throwing', () => {
    const e: any = { message: `x ${UTR}`, extra: { a: 1 } };
    e.extra.self = e;
    e.extra.list = [e.extra];
    const out = scrubEvent(e) as any;
    expect(out.message).toBe('x <ref>');
    expect(out.extra.self).toBe('[Circular]');
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(scrubEvent(null)).toBeNull();
    expect(scrubEvent(undefined)).toBeUndefined();
    expect(scrubEvent(42)).toBe(42);
    expect(scrubEvent(`paid ${UTR}`)).toBe('paid <ref>');
    expect(scrubEvent([1, { email: EMAIL }])).toEqual([1, { email: '<email>' }]);
    const getterBomb = { extra: Object.defineProperty({}, 'boom', { enumerable: true, get() { throw new Error('x'); } }) };
    expect(scrubEvent(getterBomb)).toEqual({ extra: {} });
    expect(scrubEvent({ extra: { fn: () => 1, sym: Symbol('s'), big: BigInt(123456789), nan: NaN } })).toEqual({ extra: { big: '<num>', nan: NaN } });
    let deep: any = {};
    const root = { extra: deep };
    for (let i = 0; i < 200; i++) deep = deep.next = {};
    expect(() => JSON.stringify(scrubEvent(root))).not.toThrow();
  });

  it('replaces the configured site host even without a scheme', () => {
    expect(scrubEvent({ message: 'login to erp.zp-internal failed' }, { hosts: ['erp.zp-internal'] })).toEqual({ message: 'login to <site> failed' });
  });
});

describe('scrubText', () => {
  it.each([
    ['₹ 1,234.50 sent', '<amount> sent'],
    ['Rs.500 debited', '<amount> debited'],
    ['INR 12,000', '<amount>'],
    ['USD 40.00', '<amount>'],
    ['balance 1,00,000.00 left', 'balance <amount> left'],
    ['fee 5000.00', 'fee <amount>'],
    ['acct 50100123456789', 'acct <num>'],
    ['A/C XX6507', 'A/C <acct>'],
    ['ref HDFCR52025110512345678', 'ref <ref>'],
    ['mail a.b@c.co now', 'mail <email> now'],
    ['see http://10.0.2.2:8000/app/home?x=1#y', 'see http://<site>/app/home'],
    ['version 1.0.0 and 58.0.23', 'version 1.0.0 and 58.0.23'],
    ['ErpValidationError: Value missing for Cost Center', 'ErpValidationError: Value missing for Cost Center'],
  ])('%s', (input, want) => expect(scrubText(input)).toBe(want));
});
