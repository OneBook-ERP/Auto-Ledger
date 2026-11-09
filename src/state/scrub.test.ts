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
    // T20A review: 1 or 2 decimals
    ['Paid Amount 5000.0 cannot be greater than 4000.5.', 'Paid Amount <amount> cannot be greater than <amount>.'],
    ['fee 5000.00.', 'fee <amount>.'],
    // plain integers next to a money word, whatever their size
    ['Paid Amount 500 cannot be greater than Outstanding 42', 'Paid Amount <amount> cannot be greater than Outstanding <amount>'],
    ['paid_amount=5 total: 12 balance is 7 Bal 3 rs 9 INR5', 'paid_amount=<amount> total: <amount> balance is <amount> Bal <amount> <amount> <amount>'],
    ['500 credited to your account', '<amount> credited to your account'],
    ['row 3 of 4', 'row 3 of 4'],
    // digit groups split by single spaces or dashes
    ['call +91 98765 43210 now', 'call <num> now'],
    ['acct 5010-0123-4567', 'acct <num>'],
    ['page 12 of 34', 'page 12 of 34'],
    // `_` separates tokens
    ['UTR_IDFB6292M4509651', 'UTR_<ref>'],
    ['ref_HDFCR52025110512345678_x', 'ref_<ref>_x'],
  ])('%s', (input, want) => expect(scrubText(input)).toBe(want));

  it('is idempotent on the new patterns', () => {
    for (const x of ['Paid Amount 5000.0 x', '+91 98765 43210', 'UTR_IDFB6292M4509651', 'amount 500', 'v 1.0.0 15.1']) {
      const once = scrubText(x);
      expect(scrubText(once)).toBe(once);
    }
  });

  it('caps long strings before scrubbing (8 KB + marker), and stays idempotent', () => {
    const long = `${'word '.repeat(3000)}IDFB6292M4509651`;
    const out = scrubText(long);
    expect(out.length).toBeLessThanOrEqual(8192 + ' …<truncated>'.length);
    expect(out.endsWith(' …<truncated>')).toBe(true);
    expect(out).not.toContain('IDFB6292M4509651');
    expect(scrubText(out)).toBe(out);
    expect(scrubText('short')).toBe('short');
  });

  it('runs in bounded time on pathological input (email / host patterns)', () => {
    const t0 = Date.now();
    scrubText('a'.repeat(200000));
    scrubText(`${'a.'.repeat(100000)}`);
    scrubText(`${'a-'.repeat(4000)}@${'b'.repeat(4000)}`);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('scrubEvent: keys and contexts (T20A review)', () => {
  it('scrubs object keys like text, collision-safe and idempotent', () => {
    const e = { extra: { 'IDFB6292M4509651': 'a', 'HDFCR52025110512345678': 'b', [`${'ravi@x.in'}`]: 'c', ok: 1 } };
    const out = scrubEvent(e) as any;
    expect(out.extra).toEqual({ '<ref>': 'a', '<ref>#2': 'b', '<email>': 'c', ok: 1 });
    expect(JSON.stringify(out)).not.toMatch(/IDFB|HDFCR|ravi/);
    expect(scrubEvent(out)).toEqual(out);
    // a key that is __proto__ is an ordinary key, not a prototype change
    const proto = scrubEvent(JSON.parse('{"extra":{"__proto__":{"x":1}}}')) as any;
    expect(Object.getPrototypeOf(proto.extra)).toBe(Object.prototype);
    expect(Object.keys(proto.extra)).toEqual(['__proto__']);
  });

  it('keeps trace ids and device/os/app numbers, still scrubs other contexts', () => {
    const traceId = '4c79f60c11214eb38604f4ae0781bfb2';
    const out = scrubEvent({
      contexts: {
        trace: { trace_id: traceId, span_id: 'fa90fdead5f74052', op: 'IDFB6292M4509651' },
        device: { memory_size: 8000000000, free_storage: 123456789, model: 'Pixel 8' },
        os: { name: 'Android', build_number: 1234567 },
        app: { app_memory: 9999999 },
        erp: { count: 1234567, note: 'paid 500' },
      },
    }) as any;
    expect(out.contexts.trace).toEqual({ trace_id: traceId, span_id: 'fa90fdead5f74052', op: '<ref>' });
    expect(out.contexts.device).toEqual({ memory_size: 8000000000, free_storage: 123456789, model: 'Pixel 8' });
    expect(out.contexts.os).toEqual({ name: 'Android', build_number: 1234567 });
    expect(out.contexts.app).toEqual({ app_memory: 9999999 });
    expect(out.contexts.erp).toEqual({ count: '<num>', note: 'paid <amount>' });
    expect(scrubEvent(out)).toEqual(out);
  });

  it('a non-hex trace id is scrubbed like any text', () => {
    const out = scrubEvent({ contexts: { trace: { trace_id: 'UTR IDFB6292M4509651' } } }) as any;
    expect(out.contexts.trace.trace_id).toBe('UTR <ref>');
  });
});

describe('scrubber round 2 (T20A)', () => {
  it.each([
    // more money words, before and after the number
    ['debit 500 credit 600 debited 7', 'debit <amount> credit <amount> debited <amount>'],
    ['received 300, refunded 20, sent 15, deposited 9, withdrawn 4', 'received <amount>, refunded <amount>, sent <amount>, deposited <amount>, withdrawn <amount>'],
    ['withdrawal of 42 and payment 77', 'withdrawal of <amount> and payment <amount>'],
    ['500 received and 20 refunded', '<amount> received and <amount> refunded'],
    // decimals with 3+ digits
    ['rate 1234.567 applied', 'rate <amount> applied'],
    // ISO dates and timestamps are kept
    ['posted 2026-11-09 at 2026-11-09T10:30:00.123Z', 'posted 2026-11-09 at 2026-11-09T10:30:00.123Z'],
    ['boot 2026-11-09T10:30:00+05:30', 'boot 2026-11-09T10:30:00+05:30'],
    // two-part versions after a version word are kept
    ['Android 15.1, iOS 18.2, v1.2, version 2.5, build 7.3', 'Android 15.1, iOS 18.2, v1.2, version 2.5, build 7.3'],
    ['but fee 15.1 is an amount', 'but fee <amount> is an amount'],
    // reverse-DNS names are code, not a site; a real host still is
    ['com.autoledger.app crashed at erp.example.com', 'com.autoledger.app crashed at <site>'],
    ['in /data/app/~~a==/com.autoledger.app-1/base.apk', 'in /data/app/~~a==/com.autoledger.app-1/base.apk'],
  ])('%s', (input, want) => expect(scrubText(input)).toBe(want));

  it('a URL inside a URL is scrubbed in one pass (idempotent)', () => {
    const once = scrubText('see http://http://erp.zp.in/x?q=1 and https://a.example.app/https://b.example.app/y');
    expect(once).toBe('see http://<site>//<site>/x and https://<site>/https://<site>/y');
    expect(scrubText(once)).toBe(once);
  });

  it('keeps device/os/app context strings (versions, builds, identifiers, boot time) and frame code paths', () => {
    const e = {
      contexts: {
        os: { name: 'Android', version: '15.1', build: 'AP3A.241105.008', kernel_version: '6.1.75' },
        app: { app_build: '58', app_identifier: 'com.autoledger.app', app_version: '1.0' },
        device: { boot_time: '2026-11-09T04:12:55Z', memory_size: 8000000000 },
      },
      exception: { values: [{ type: 'Error', value: 'x', stacktrace: { frames: [
        { filename: '/data/app/~~QvKc9a1B2c3D4e5F6g==/com.autoledger.app-Xy12AbCd34EfGh==/base.apk', lineno: 1 },
        { filename: 'app:///index.android.bundle', abs_path: 'app:///index.android.bundle', lineno: 2 },
      ] } }] },
    };
    const out = scrubEvent(e) as any;
    expect(out.contexts).toEqual(e.contexts);
    expect(out.exception.values[0].stacktrace.frames).toEqual(e.exception.values[0].stacktrace.frames);
    expect(scrubEvent(out)).toEqual(out);
    // other contexts still get the number patterns
    expect((scrubEvent({ contexts: { erp: { v: '15.1', when: '2026-11-09' } } }) as any).contexts.erp).toEqual({ v: '<amount>', when: '2026-11-09' });
    // a frame "path" with whitespace is ordinary text
    expect((scrubEvent({ extra: { filename: '/x paid 500' } }) as any).extra.filename).toBe('/x paid <amount>');
  });

  it('caps the scrubbed text per event (256 KB): later strings become <truncated>', () => {
    const big = 'word '.repeat(1600); // 8000 chars
    const extra: Record<string, string> = {};
    for (let i = 0; i < 40; i++) extra[`k${i}`] = `${big}IDFB6292M4509651`;
    const out = scrubEvent({ extra }) as any;
    const vals = Object.values(out.extra) as string[];
    expect(vals.filter((v) => v === '<truncated>').length).toBeGreaterThan(0);
    expect(vals.filter((v) => v !== '<truncated>').length).toBeLessThanOrEqual(33);
    expect(JSON.stringify(out)).not.toContain('IDFB6292M4509651');
  });

  const kb8 = (unit: string) => unit.repeat(Math.ceil(8192 / unit.length)).slice(0, 8192);
  it.each([
    ['500 strings of x', () => ({ extra: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, kb8('x')])) })],
    ['1,1,1,…', () => ({ message: kb8('1,'), extra: { a: kb8('1,'), b: kb8('Rs1,'), c: kb8('amount 1,') } })],
    ['1.1.1…', () => ({ message: kb8('1.'), extra: { a: kb8('1.'), b: kb8('v1.1 '), c: kb8('1,1.1 ') } })],
    ['long digit runs', () => ({ message: kb8('1'), extra: { a: kb8('1'), b: kb8('1 '), c: kb8('+1'), d: kb8('X1') } })],
    ['token-ish runs', () => ({ message: kb8('a@'), extra: { a: kb8('a.'), b: kb8('a-a.'), c: kb8('XX'), d: kb8('a1'), e: kb8('http://'), f: kb8('2026-11-09') } })],
  ])('a pathological event (%s) is scrubbed in under 1 s', (_l, make) => {
    const e = make();
    const t0 = Date.now();
    const out = scrubEvent(e);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out).not.toBeNull();
  });
});
