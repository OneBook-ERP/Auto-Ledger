import fixtures from '../../fixtures/sms/idfc.json';
import idfc from '../../templates/idfc.json';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import type { TemplateSet } from '../core/types';
import { parseSms } from '../core/parser';
import { SMOKE_SAMPLES, activeTemplateVersion, loadTemplates, refreshTemplates, validateTemplateSet } from './templates';

type Fixture = { id: string; sender: string; body: string; receivedAt: number; expected: any };
const byId = (id: string) => (fixtures as Fixture[]).find((f) => f.id === id)!;

const bundled = idfc as TemplateSet;
const clone = (): any => JSON.parse(JSON.stringify(bundled));
const v2 = (): any => ({ ...clone(), version: 2 });

class FakeNative {
  calls: string[] = [];
  result = true;
  async setTemplates(json: string) { this.calls.push(json); return this.result; }
}

function fakeFetch(body: string | (() => Promise<never>), init: { status?: number; headers?: Record<string, string>; url?: string } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, reqInit?: RequestInit) => {
    calls.push({ url, init: reqInit });
    if (typeof body === 'function') return body();
    const status = init.status ?? 200;
    const headers = init.headers ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      url: init.url ?? url,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const URL_OK = 'https://example.com/templates/idfc.json';

async function mk(): Promise<Repo> { return createRepo(createTestDriver()); }

describe('validateTemplateSet', () => {
  it('accepts the bundled set (string or object)', () => {
    expect(validateTemplateSet(bundled)).toEqual({ ok: true, set: bundled });
    expect(validateTemplateSet(JSON.stringify(bundled)).ok).toBe(true);
  });

  const bad: [string, () => unknown, RegExp][] = [
    ['not JSON', () => '{nope', /JSON/i],
    ['not an object', () => [1, 2], /object/i],
    ['missing otpPattern', () => { const s = clone(); delete s.otpPattern; return s; }, /otpPattern/],
    ['empty-matching otpPattern "|"', () => ({ ...clone(), otpPattern: '|' }), /otpPattern.*empty/i],
    ['whitespace-only moneyVerbPattern', () => ({ ...clone(), moneyVerbPattern: '   ' }), /moneyVerbPattern/],
    ['empty-matching amountPattern', () => ({ ...clone(), amountPattern: '\\d*' }), /amountPattern.*empty/i],
    ['inline flags', () => ({ ...clone(), otpPattern: '(?i)otp \\d{6}' }), /inline flag/i],
    ['invalid template regex', () => { const s = clone(); s.banks[0].templates[3].regex = '(?<amount>[\\d'; return s; }, /compile/i],
    ['unknown group name', () => { const s = clone(); s.banks[0].templates[3].regex = 'credited (?<amount>\\d+) (?<foo>\\w+)'; return s; }, /group.*foo/i],
    ['money template without amount group', () => { const s = clone(); s.banks[0].templates[3].regex = 'credited with \\d+'; return s; }, /amount/i],
    ['template regex matching the empty string', () => { const s = clone(); s.banks[0].templates[0].regex = 'x?'; return s; }, /empty/i],
    ['non-integer version', () => ({ ...clone(), version: 1.5 }), /version/i],
    ['zero version', () => ({ ...clone(), version: 0 }), /version/i],
    ['string version', () => ({ ...clone(), version: '2' }), /version/i],
    ['empty banks', () => ({ ...clone(), banks: [] }), /banks/i],
    ['bank without templates', () => { const s = clone(); s.banks[0].templates = []; return s; }, /templates/i],
    ['bad kind', () => { const s = clone(); s.banks[0].templates[3].kind = 'upi_credit'; return s; }, /kind/i],
    ['bad accountType', () => { const s = clone(); s.banks[0].templates[3].accountType = 'wallet'; return s; }, /accountType/i],
    ['empty senderPattern', () => { const s = clone(); s.banks[0].senderPattern = ' '; return s; }, /senderPattern/i],
  ];
  for (const [name, make, why] of bad) {
    it(`rejects: ${name}`, () => {
      const r = validateTemplateSet(make());
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });
  }

  it('rejects a version that is not newer than the active one', () => {
    expect(validateTemplateSet(v2(), { activeVersion: 2 }).ok).toBe(false);
    const r = validateTemplateSet(clone(), { activeVersion: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/version/i);
    expect(validateTemplateSet(v2(), { activeVersion: 1 }).ok).toBe(true);
  });

  it('rejects a set that compiles but fails the built-in smoke check', () => {
    const s = clone();
    // Valid regex, allowed groups, but the short credit template no longer recognises the real format.
    s.banks[0].templates[3].regex = 'A/C X+\\d*(?<last4>\\d{4}) got (?<amount>[\\d,]+)';
    const r = validateTemplateSet(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/smoke/i);
  });

  it('smoke samples are real fixtures and the bundled set parses them as the fixtures expect', () => {
    expect(SMOKE_SAMPLES.length).toBeGreaterThanOrEqual(3);
    for (const s of SMOKE_SAMPLES) {
      const f = byId(s.fixtureId);
      expect(s.sender).toBe(f.sender);
      expect(s.body).toBe(f.body);
      const r = parseSms(f.sender, f.body, f.receivedAt, bundled);
      if (f.expected.ok) {
        expect(r.ok && r.txn).toMatchObject(f.expected.txn);
      } else {
        expect(r).toEqual({ ok: false, reason: f.expected.reason });
      }
    }
  });
});

describe('loadTemplates', () => {
  it('uses the bundled set when nothing is persisted', async () => {
    const repo = await mk();
    expect(await loadTemplates(repo)).toBe(bundled);
    expect(await activeTemplateVersion(repo)).toBe(1);
  });
  it('uses a valid persisted set', async () => {
    const repo = await mk();
    await repo.setSetting('templates_json', JSON.stringify(v2()));
    expect((await loadTemplates(repo)).version).toBe(2);
    expect(await activeTemplateVersion(repo)).toBe(2);
  });
  it('falls back to the bundled set when the persisted one is corrupt or invalid', async () => {
    const repo = await mk();
    await repo.setSetting('templates_json', '{broken');
    expect(await loadTemplates(repo)).toBe(bundled);
    await repo.setSetting('templates_json', JSON.stringify({ ...v2(), otpPattern: '|' }));
    expect(await loadTemplates(repo)).toBe(bundled);
  });
  it('falls back to the bundled set when the repo throws', async () => {
    const repo = await mk();
    const broken: Repo = { ...repo, getSetting: async () => { throw new Error('db gone'); } };
    expect(await loadTemplates(broken)).toBe(bundled);
  });
});

describe('refreshTemplates', () => {
  async function expectOldSetKept(repo: Repo, native: FakeNative) {
    expect(native.calls).toEqual([]);
    expect(await repo.getSetting('templates_json')).toBeNull();
    expect(await repo.getSetting('templates_version')).toBeNull();
    expect(await loadTemplates(repo)).toBe(bundled);
  }

  it('applies a valid higher version once; a second call is unchanged', async () => {
    const repo = await mk();
    const native = new FakeNative();
    const json = JSON.stringify(v2());
    const f = fakeFetch(json);
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: f.impl, repo, native })).toBe('updated');
    expect(native.calls).toEqual([json]);
    expect(await repo.getSetting('templates_json')).toBe(json);
    expect(await repo.getSetting('templates_version')).toBe('2');
    expect((await loadTemplates(repo)).version).toBe(2);

    expect(await refreshTemplates({ url: URL_OK, fetchImpl: f.impl, repo, native })).toBe('unchanged');
    expect(native.calls.length).toBe(1);
    expect(f.calls.length).toBe(2);
  });

  it('the bundled version itself is unchanged', async () => {
    const repo = await mk();
    const native = new FakeNative();
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify(bundled)).impl, repo, native })).toBe('unchanged');
    expect(native.calls).toEqual([]);
  });

  it('refuses a non-https url without fetching', async () => {
    const repo = await mk();
    const native = new FakeNative();
    const f = fakeFetch(JSON.stringify(v2()));
    expect(await refreshTemplates({ url: 'http://example.com/t.json', fetchImpl: f.impl, repo, native })).toBe('failed');
    expect(f.calls).toEqual([]);
    await expectOldSetKept(repo, native);
  });

  it('refuses a redirect to a non-https url', async () => {
    const repo = await mk();
    const native = new FakeNative();
    const f = fakeFetch(JSON.stringify(v2()), { url: 'http://evil.example.com/t.json' });
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: f.impl, repo, native })).toBe('failed');
    await expectOldSetKept(repo, native);
  });

  const failing: [string, () => ReturnType<typeof fakeFetch>][] = [
    ['network error', () => fakeFetch(async () => { throw new TypeError('Network request failed'); })],
    ['HTTP 404', () => fakeFetch('not found', { status: 404 })],
    ['oversized by content-length', () => fakeFetch(JSON.stringify(v2()), { headers: { 'content-length': String(300 * 1024) } })],
    ['oversized body', () => fakeFetch(JSON.stringify({ ...v2(), notes: ['x'.repeat(300 * 1024)] }))],
    ['invalid JSON', () => fakeFetch('{"version": 2,')],
    ['regex that does not compile', () => { const s = v2(); s.banks[0].templates[4].regex = '(?<amount>[0-9'; return fakeFetch(JSON.stringify(s)); }],
    ['empty-matching pattern', () => fakeFetch(JSON.stringify({ ...v2(), otpPattern: '|' }))],
    ['unknown group', () => { const s = v2(); s.banks[0].templates[4].regex = '(?<amount>\\d+) (?<bogus>x)'; return fakeFetch(JSON.stringify(s)); }],
    ['lower version', () => fakeFetch(JSON.stringify({ ...clone(), version: 0 }))],
    ['non-integer version', () => fakeFetch(JSON.stringify({ ...clone(), version: 2.5 }))],
    ['empty banks', () => fakeFetch(JSON.stringify({ ...v2(), banks: [] }))],
    ['smoke check fails', () => { const s = v2(); s.banks[0].templates[3].regex = 'A/C X+\\d*(?<last4>\\d{4}) got (?<amount>[\\d,]+)'; return fakeFetch(JSON.stringify(s)); }],
  ];
  for (const [name, make] of failing) {
    it(`keeps the old set on: ${name}`, async () => {
      const repo = await mk();
      const native = new FakeNative();
      expect(await refreshTemplates({ url: URL_OK, fetchImpl: make().impl, repo, native })).toBe('failed');
      await expectOldSetKept(repo, native);
    });
  }

  it('keeps the old set when native rejects the set', async () => {
    const repo = await mk();
    const native = new FakeNative();
    native.result = false;
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify(v2())).impl, repo, native })).toBe('failed');
    expect(native.calls.length).toBe(1);
    expect(await repo.getSetting('templates_json')).toBeNull();
    expect(await loadTemplates(repo)).toBe(bundled);
  });

  it('keeps the old set when native throws', async () => {
    const repo = await mk();
    const native = { setTemplates: async () => { throw new Error('bridge down'); } };
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify(v2())).impl, repo, native })).toBe('failed');
    expect(await repo.getSetting('templates_json')).toBeNull();
  });

  it('a lower version than an applied override fails and keeps the override', async () => {
    const repo = await mk();
    const native = new FakeNative();
    await refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify({ ...clone(), version: 3 })).impl, repo, native });
    expect(await refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify(v2())).impl, repo, native })).toBe('failed');
    expect((await loadTemplates(repo)).version).toBe(3);
    expect(native.calls.length).toBe(1);
  });

  it('times out after 10 s and keeps the old set', async () => {
    jest.useFakeTimers();
    try {
      const repo = await mk();
      const native = new FakeNative();
      let aborted = false;
      const hang = (async (_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; rej(new Error('aborted')); });
      })) as unknown as typeof fetch;
      const p = refreshTemplates({ url: URL_OK, fetchImpl: hang, repo, native });
      await jest.advanceTimersByTimeAsync(9_999);
      let settled = false;
      p.then(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(2);
      expect(await p).toBe('failed');
      expect(aborted).toBe(true);
      expect(native.calls).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('never throws, even when the repo fails', async () => {
    const repo = await mk();
    const broken: Repo = { ...repo, setSetting: async () => { throw new Error('disk full'); }, getSetting: async () => { throw new Error('db gone'); } };
    const native = new FakeNative();
    await expect(refreshTemplates({ url: URL_OK, fetchImpl: fakeFetch(JSON.stringify(v2())).impl, repo: broken, native })).resolves.toBe('failed');
  });
});
