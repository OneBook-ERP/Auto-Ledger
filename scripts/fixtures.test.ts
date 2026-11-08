import fixtures from '../fixtures/sms/idfc.json';

describe('fixtures/sms/idfc.json', () => {
  it('has unique ids and no digit run of 9+ in any body', () => {
    const ids = new Set(fixtures.map((f) => f.id));
    expect(ids.size).toBe(fixtures.length);
    for (const f of fixtures) expect(f.body).not.toMatch(/\d{9,}/);
  });
});
