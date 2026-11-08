import { STAGE_URL, assertStageUrl, readOnlyInit, groupDuplicates, staleDrafts, type DocRow } from './pilotDuplicates';

const row = (o: Partial<DocRow> & { name: string }): DocRow => ({
  doctype: 'Payment Entry', reference: null, docstatus: 0, creation: '2026-11-09 10:00:00.000000', ...o,
});

describe('assertStageUrl', () => {
  it('accepts exactly the stage host', () => expect(assertStageUrl(STAGE_URL)).toBe(STAGE_URL));
  it.each([undefined, '', 'https://atom.onebook.app', 'https://stageatom.onebook.app/', 'http://stageatom.onebook.app', 'https://stageatom.onebook.app.evil.test'])(
    'rejects %p',
    (u) => expect(() => assertStageUrl(u as string | undefined)).toThrow(/exactly/),
  );
});

describe('groupDuplicates', () => {
  it('groups equal references across doctypes and ignores cancelled and blank ones', () => {
    const rows = [
      row({ name: 'PE-1', reference: 'UTR1' }),
      row({ name: 'JV-1', doctype: 'Journal Entry', reference: 'UTR1', docstatus: 1 }),
      row({ name: 'PE-2', reference: 'UTR2' }),
      row({ name: 'PE-3', reference: 'UTR2', docstatus: 2 }), // cancelled: not a duplicate
      row({ name: 'PE-4', reference: '' }),
      row({ name: 'PE-5', reference: null }),
      row({ name: 'PE-6', reference: ' ' }),
      row({ name: 'PE-7', reference: 'AL-1' }),
      row({ name: 'PE-8', reference: 'AL-1' }),
    ];
    const g = groupDuplicates(rows);
    expect(g.map((x) => x.reference)).toEqual(['AL-1', 'UTR1']);
    expect(g[1].docs.map((d) => d.name)).toEqual(['PE-1', 'JV-1']);
  });
  it('returns nothing when all references are unique', () => {
    expect(groupDuplicates([row({ name: 'A', reference: 'x' }), row({ name: 'B', reference: 'y' })])).toEqual([]);
  });
});

describe('staleDrafts', () => {
  const now = new Date('2026-11-12T12:00:00Z');
  it('keeps only docstatus 0 older than N days, oldest first', () => {
    const rows = [
      row({ name: 'new', creation: '2026-11-12 08:00:00.000000' }),
      row({ name: 'old2', creation: '2026-11-08 08:00:00.000000' }),
      row({ name: 'old1', creation: '2026-11-05 08:00:00.000000' }),
      row({ name: 'sub', creation: '2026-11-01 08:00:00.000000', docstatus: 1 }),
    ];
    expect(staleDrafts(rows, now, 2).map((r) => r.name)).toEqual(['old1', 'old2']);
  });
  it('ignores unparseable timestamps', () => {
    expect(staleDrafts([row({ name: 'x', creation: 'garbage' })], now, 1)).toEqual([]);
  });
});

describe('readOnlyInit', () => {
  it('is a GET that errors on redirects', () => {
    const i = readOnlyInit('token k:s');
    expect(i.method).toBe('GET');
    expect(i.redirect).toBe('error');
    expect(i.headers.Authorization).toBe('token k:s');
  });
});
