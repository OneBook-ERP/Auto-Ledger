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
});
