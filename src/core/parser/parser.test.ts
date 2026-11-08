import fixtures from '../../../fixtures/sms/idfc.json';
import idfc from '../../../templates/idfc.json';
import { parseSms } from './engine';
import type { TemplateSet, ParseResult } from '../types';

const templates = idfc as TemplateSet;

type Fixture = { id: string; sender: string; body: string; receivedAt: number; expected: any };

describe('idfc fixtures', () => {
  for (const f of fixtures as Fixture[]) {
    it(f.id, () => {
      const r = parseSms(f.sender, f.body, f.receivedAt, templates);
      if (f.expected.ok) {
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.txn).toMatchObject(f.expected.txn);
          expect(r.txn.sender).toBe(f.sender);
          expect(r.txn.receivedAt).toBe(f.receivedAt);
          expect(typeof r.txn.rawHash).toBe('string');
        }
      } else {
        expect(r).toEqual({ ok: false, reason: f.expected.reason });
      }
    });
  }
});

function byId(id: string): Fixture {
  return (fixtures as Fixture[]).find((f) => f.id === id)!;
}
function parse(id: string): ParseResult {
  const f = byId(id);
  return parseSms(f.sender, f.body, f.receivedAt, templates);
}

describe('named cases', () => {
  it('short CA credit', () => {
    const r = parse('idfc-001');
    expect(r.ok && r.txn).toMatchObject({
      kind: 'ca_credit', direction: 'in', amountMinor: 1293200, occurredOn: '2026-09-02',
      occurredTime: '09:13', counterparty: null, utr: null, balanceMinor: 51293276,
    });
  });
  it('long CA credit', () => {
    const r = parse('idfc-009');
    expect(r.ok && r.txn).toMatchObject({
      counterparty: 'COMPANY_88', accountLast4: '6507', occurredTime: null,
    });
  });
  it('USD card spend', () => {
    const r = parse('idfc-040');
    expect(r.ok && r.txn).toMatchObject({
      kind: 'card_spend', currency: 'USD', amountMinor: 10000, accountLast4: '3455',
      merchant: 'ANTHROPIC* CLAUDE SUB', occurredOn: '2026-11-08', occurredTime: '17:41',
    });
  });
  it('SI notice vs SI paid', () => {
    expect(parse('idfc-042')).toEqual({ ok: false, reason: 'si_notice' });
    const r = parse('idfc-041');
    expect(r.ok && r.txn.kind).toBe('card_si_paid');
  });
  it('OTP, limit alert, other bank', () => {
    expect(parse('synthetic-otp')).toEqual({ ok: false, reason: 'otp' });
    expect(parse('idfc-051')).toEqual({ ok: false, reason: 'not_money' });
    expect(parseSms('AX-HDFCBK-S', 'Rs 5 debited from A/c', 0, templates))
      .toEqual({ ok: false, reason: 'unknown_template' });
  });
  it('card payment thank-you is not_money', () => {
    expect(parse('idfc-057')).toEqual({ ok: false, reason: 'not_money' });
  });
  it('an unrecognised IDFC money message is unknown_template, not silently dropped', () => {
    expect(parseSms('JM-IDFCFB-S', 'Your A/c XX6507 is reversed credited with Rs 5.00 on 1/1', 0, templates))
      .toEqual({ ok: false, reason: 'unknown_template' });
  });
  it('rawHash is stable for same sender+body, independent of receivedAt and whitespace', () => {
    const f = byId('idfc-001');
    const a = parseSms(f.sender, f.body, 1000, templates);
    const b = parseSms(f.sender, ' ' + f.body + '\n', 999999999, templates);
    const c = parseSms(f.sender, f.body + ' x', 1000, templates);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.txn.rawHash).toBe(b.txn.rawHash);
      expect(a.txn.rawHash).not.toBe(c.txn.rawHash);
    }
  });
  it('body without a date uses the Asia/Kolkata date of receivedAt', () => {
    // 2026-11-07 20:00 UTC is already 2026-11-08 in IST
    const f = byId('idfc-018');
    const r = parseSms(f.sender, f.body, Date.UTC(2026, 10, 7, 20, 0), templates);
    expect(r.ok && r.txn.occurredOn).toBe('2026-11-08');
  });

  it('a money SMS mentioning OTP in a footer still parses', () => {
    for (const id of ['idfc-001', 'idfc-040', 'idfc-006']) {
      const f = byId(id);
      const r = parseSms(f.sender, f.body + ' Never share your OTP with anyone.', f.receivedAt, templates);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.txn.kind).toBe(f.expected.txn.kind);
    }
  });
  it('NBSP and other Unicode spaces parse like plain spaces', () => {
    for (const id of ['idfc-001', 'idfc-025']) {
      const f = byId(id);
      const plain = parseSms(f.sender, f.body, f.receivedAt, templates);
      const nb = f.body.replace(/ (?=INR|Rs|on |at |spent|credited|Avbl)/g, '\u00A0').replace(/ (?=[AP]M)/g, '\u202F');
      expect(nb).not.toBe(f.body);
      expect(plain.ok).toBe(true);
      expect(parseSms(f.sender, nb, f.receivedAt, templates)).toEqual(plain);
      const otp = parseSms(f.sender, nb + ' Never share your OTP with anyone.', f.receivedAt, templates);
      expect(otp.ok).toBe(true);
    }
    expect(parseSms('VM-IDFCFB-S', 'Your OTP\u00A0is\u00A0123456 for login', 0, templates)).toEqual({ ok: false, reason: 'otp' });
  });

  it('OTP phrasings are detected', () => {
    for (const b of ['Your OTP is 123456 for login', 'OTP for txn of Rs 5 is 98765432', '4821 is the OTP to pay', 'Use one time password: 5566']) {
      expect(parseSms('VM-IDFCFB-S', b, 0, templates)).toEqual({ ok: false, reason: 'otp' });
    }
  });
  it('IST day boundary at 18:30 UTC', () => {
    const f = byId('idfc-018');
    const a = parseSms(f.sender, f.body, Date.UTC(2026, 10, 7, 18, 29, 59), templates);
    const b = parseSms(f.sender, f.body, Date.UTC(2026, 10, 7, 18, 30, 0), templates);
    expect(a.ok && a.txn.occurredOn).toBe('2026-11-07');
    expect(b.ok && b.txn.occurredOn).toBe('2026-11-08');
  });
});

describe('parseSms is total', () => {
  const credit = (day: string, mon: string, amt = '1,000.00') =>
    `Your A/C XXXXX996507 is credited with INR ${amt} on ${day}/${mon}/26 09:13. Your new balance is INR 5,12,932.76. Team IDFC FIRST Bank`;
  const cases: [string, string][] = [
    ['bad month name', 'Your a/c no. XXXXXXXX507 is credited by Rs. 5.00 on 01-Xyz-26 by a/c linked to mobile XXXXXXXXX612 (IMPS Ref no 40273725 ).'],
    ['comma-only amount', credit('02', '09', ',,,')],
    ['day 00', credit('00', '09')],
    ['day 32', credit('32', '09')],
    ['month 13', credit('02', '13')],
    ['month 00', credit('02', '00')],
  ];
  for (const [name, body] of cases) {
    it(name, () => {
      let r: ParseResult | undefined;
      expect(() => { r = parseSms('JM-IDFCFB-S', body, 0, templates); }).not.toThrow();
      expect(r).toEqual({ ok: false, reason: 'unknown_template' });
    });
  }
  it('template missing the amount group', () => {
    const t: TemplateSet = { ...templates, banks: [{ id: 'x', senderPattern: 'IDFCFB', templates: [
      { id: 'bad', kind: 'ca_credit', direction: 'in', accountType: 'bank', regex: 'credited' }] }] };
    expect(parseSms('JM-IDFCFB-S', 'credited Rs 5', 0, t)).toEqual({ ok: false, reason: 'unknown_template' });
  });
  it('invalid regex in a template', () => {
    const t: TemplateSet = { ...templates, banks: [{ id: 'x', senderPattern: 'IDFCFB', templates: [
      { id: 'bad', kind: 'ca_credit', direction: 'in', accountType: 'bank', regex: '(' }] }] };
    expect(parseSms('JM-IDFCFB-S', 'credited Rs 5', 0, t)).toEqual({ ok: false, reason: 'unknown_template' });
  });
});
