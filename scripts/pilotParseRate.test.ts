import fixtures from '../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from '../src/core/parser';
import { evaluateFixtures, formatReport, type Fixture, type ParseFn } from './pilotParseRate';

const mk = (id: string, expected: Fixture['expected']): Fixture => ({ id, sender: 'X-IDFCFB-S', body: id, receivedAt: 0, expected });

describe('evaluateFixtures', () => {
  const fx: Fixture[] = [
    mk('a', { ok: true, txn: { kind: 'ca_credit', amountMinor: 100 } }),
    mk('b', { ok: true, txn: { kind: 'ca_debit', amountMinor: 200 } }),
    mk('c', { ok: false, reason: 'otp' }),
  ];
  const parse: ParseFn = (_s, body) => {
    if (body === 'a') return { ok: true, txn: { kind: 'ca_credit', amountMinor: 100 } as never };
    if (body === 'b') return { ok: true, txn: { kind: 'ca_debit', amountMinor: 999 } as never }; // wrong amount
    return { ok: false, reason: 'otp' };
  };

  it('counts per kind and only credits a money fixture when every listed field matches', () => {
    const r = evaluateFixtures(fx, bundledTemplates, parse);
    expect(r.perKind).toEqual({ ca_credit: 1, ca_debit: 1, 'ignore:otp': 1 });
    expect(r.money).toEqual({ total: 2, correct: 1, percent: 50 });
    expect(r.ignored).toEqual({ total: 1, correct: 1 });
    expect(r.failures).toEqual(['b']);
    expect(r.meetsTarget).toBe(false);
    expect(formatReport(r)).toContain('target NOT met');
  });

  it('treats a money fixture parsed as ignored (or an ignore fixture parsed as money) as a mismatch', () => {
    const none: ParseFn = () => ({ ok: false, reason: 'unknown_template' });
    expect(evaluateFixtures(fx, bundledTemplates, none).money.correct).toBe(0);
    const all: ParseFn = () => ({ ok: true, txn: { kind: 'ca_credit', amountMinor: 100 } as never });
    expect(evaluateFixtures([fx[2]], bundledTemplates, all).failures).toEqual(['c']);
  });

  it('does not meet the target with no money fixtures', () => {
    expect(evaluateFixtures([], bundledTemplates, parse).meetsTarget).toBe(false);
  });

  it('the bundled templates meet the 95% target on the committed fixtures', () => {
    const r = evaluateFixtures(fixtures as unknown as Fixture[], bundledTemplates, parseSms);
    expect(r.meetsTarget).toBe(true);
    expect(r.money.total).toBeGreaterThan(0);
  });
});
