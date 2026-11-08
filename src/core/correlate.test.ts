import fixtures from '../../fixtures/sms/idfc.json';
import { bundledTemplates, parseSms } from './parser';
import { correlate } from './correlate';
import type { ParsedTxn, PendingTxn } from './types';

const H = 3600_000;
const D = 24 * H;

function pending(t: ParsedTxn, id: string, state: PendingTxn['state'] = 'new', mergedCount = 1): PendingTxn {
  return { ...t, id, mergedCount, state, createdDocs: [], error: null };
}
function parsed(id: string): ParsedTxn {
  const f = (fixtures as { id: string; sender: string; body: string; receivedAt: number }[]).find((x) => x.id === id)!;
  const r = parseSms(f.sender, f.body, f.receivedAt, bundledTemplates);
  if (!r.ok) throw new Error(`fixture ${id} did not parse`);
  return r.txn;
}
const base: ParsedTxn = {
  kind: 'ca_debit', direction: 'out', amountMinor: 50000, currency: 'INR', occurredOn: '2026-10-01',
  occurredTime: null, accountType: 'bank', accountLast4: '1234', counterparty: null, utr: null,
  merchant: null, balanceMinor: null, sender: 'X', receivedAt: 1_000_000_000_000, rawHash: 'h1',
};
const mk = (o: Partial<ParsedTxn>): ParsedTxn => ({ ...base, ...o });

describe('correlate (hand-built)', () => {
  it('a: identical rawHash drops duplicate', () => {
    const ex = pending(base, 'p1');
    expect(correlate([ex], mk({ receivedAt: base.receivedAt + 5 * D }))).toEqual({ action: 'drop_duplicate', of: 'p1', reason: 'same_sms' });
  });

  it('b: neft_confirm enriches a debit lacking utr within 48h', () => {
    const ex = pending(base, 'p1');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'h2', receivedAt: base.receivedAt + 47 * H, counterparty: 'ACME', utr: 'U1', accountLast4: null });
    expect(correlate([ex], inc)).toEqual({ action: 'enrich', target: 'p1', patch: { counterparty: 'ACME', utr: 'U1' } });
  });

  it('b2: no match beyond 48h', () => {
    const ex = pending(base, 'p1');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'h2', receivedAt: base.receivedAt + 49 * H, utr: 'U1' });
    expect(correlate([ex], inc)).toEqual({ action: 'insert' });
  });

  it('b3: same utr matches regardless of amount/time; patch only missing fields', () => {
    const ex = pending(mk({ utr: 'U1' }), 'p1');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'h2', amountMinor: 1, receivedAt: base.receivedAt + 9 * D, counterparty: 'ACME', utr: 'U1' });
    expect(correlate([ex], inc)).toEqual({ action: 'enrich', target: 'p1', patch: { counterparty: 'ACME' } });
  });

  it('b4: debit with a different utr is not matched by amount', () => {
    const ex = pending(mk({ utr: 'U9' }), 'p1');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'h2', utr: 'U1', counterparty: 'ACME' });
    expect(correlate([ex], inc)).toEqual({ action: 'insert' });
  });

  it('c: neft_confirm with no matching debit inserts', () => {
    const ex = pending(mk({ amountMinor: 99 }), 'p1');
    expect(correlate([ex], mk({ kind: 'neft_confirm', rawHash: 'h2', utr: 'U1' }))).toEqual({ action: 'insert' });
    expect(correlate([], mk({ kind: 'neft_confirm', rawHash: 'h2', utr: 'U1' }))).toEqual({ action: 'insert' });
  });

  const card = (o: Partial<ParsedTxn>) =>
    mk({ kind: 'card_spend', accountType: 'card', accountLast4: '3455', occurredTime: '10:00', merchant: 'Facebook', amountMinor: 224071, ...o });

  it('d: card_si_paid + card_spend with same normalised merchant is a duplicate', () => {
    const si = pending(card({ kind: 'card_si_paid', occurredTime: null, accountLast4: '3455', merchant: 'face-book', rawHash: 'a' }), 'p1');
    const sp = card({ merchant: 'FACEBOOK  SI', rawHash: 'b', receivedAt: base.receivedAt + 1 * D });
    // existing is the si_paid and lacks the time: enrich
    expect(correlate([si], sp)).toEqual({ action: 'enrich', target: 'p1', patch: { occurredTime: '10:00' } });
    // existing is the spend: drop the incoming si_paid
    const ex = pending(sp, 'p2');
    expect(correlate([ex], card({ kind: 'card_si_paid', merchant: 'Face Book', occurredTime: null, rawHash: 'c' }))).toEqual({ action: 'drop_duplicate', of: 'p2', reason: 'paired' });
  });

  it('d2: enrich with nothing missing drops duplicate', () => {
    const si = pending(card({ kind: 'card_si_paid', occurredTime: '09:00', rawHash: 'a' }), 'p1');
    expect(correlate([si], card({ rawHash: 'b' }))).toEqual({ action: 'drop_duplicate', of: 'p1', reason: 'paired' });
  });

  it('d3: different amount, currency, or >2 days apart do not match', () => {
    const si = pending(card({ kind: 'card_si_paid', rawHash: 'a' }), 'p1');
    expect(correlate([si], card({ rawHash: 'b', amountMinor: 1 }))).toEqual({ action: 'insert' });
    expect(correlate([si], card({ rawHash: 'b', currency: 'USD' }))).toEqual({ action: 'insert' });
    expect(correlate([si], card({ rawHash: 'b', receivedAt: base.receivedAt + 2 * D + 1 }))).toEqual({ action: 'insert' });
  });

  it('e: two genuine same-day charges with different amounts both insert', () => {
    const a = pending(card({ rawHash: 'a', amountMinor: 100000 }), 'p1');
    const inc = card({ kind: 'card_si_paid', rawHash: 'b', amountMinor: 200000 });
    expect(correlate([a], inc)).toEqual({ action: 'insert' });
    expect(correlate([a, pending(inc, 'p2')], card({ rawHash: 'c', amountMinor: 300000 }))).toEqual({ action: 'insert' });
  });

  it('e2: two card_spends with equal amounts are genuine separate charges', () => {
    const a = pending(card({ rawHash: 'a' }), 'p1');
    expect(correlate([a], card({ rawHash: 'b' }))).toEqual({ action: 'insert' });
  });

  it('f: created/submitted target still enriches', () => {
    for (const state of ['created', 'submitted'] as const) {
      const ex = pending(base, 'p1', state);
      const inc = mk({ kind: 'neft_confirm', rawHash: 'h2', counterparty: 'ACME', utr: 'U1' });
      expect(correlate([ex], inc)).toEqual({ action: 'enrich', target: 'p1', patch: { counterparty: 'ACME', utr: 'U1' } });
    }
  });

  it('never matches across direction or accountType', () => {
    const ex = pending(base, 'p1');
    expect(correlate([ex], mk({ kind: 'neft_confirm', rawHash: 'h2', direction: 'in', utr: 'U1' }))).toEqual({ action: 'insert' });
    expect(correlate([ex], mk({ kind: 'neft_confirm', rawHash: 'h2', accountType: 'card', utr: 'U1' }))).toEqual({ action: 'insert' });
  });
});

describe('correlate (real fixtures)', () => {
  const pairs: [string, string][] = [
    ['idfc-010', 'idfc-018'], ['idfc-012', 'idfc-019'], ['idfc-013', 'idfc-020'],
    ['idfc-014', 'idfc-023'], ['idfc-015', 'idfc-024'],
  ];
  for (const [d, n] of pairs) {
    it(`debit ${d} + NEFT confirm ${n}`, () => {
      const deb = parsed(d);
      const conf = parsed(n);
      // The real debit SMS already carries utr and counterparty, so the
      // confirmation adds nothing: duplicate of the debit.
      expect(correlate([pending(deb, 'p1')], conf)).toEqual({ action: 'drop_duplicate', of: 'p1', reason: 'empty_patch' });
      // Strip them and the confirmation enriches.
      const bare = { ...deb, utr: null, counterparty: null };
      expect(correlate([pending(bare, 'p1')], conf)).toEqual({
        action: 'enrich', target: 'p1',
        patch: conf.counterparty ? { counterparty: conf.counterparty, utr: conf.utr } : { utr: conf.utr },
      });
      // the debit delivered twice is a duplicate
      expect(correlate([pending(deb, 'p1')], deb)).toEqual({ action: 'drop_duplicate', of: 'p1', reason: 'same_sms' });
    });
  }

  const trios: [string, string][] = [['idfc-041', 'idfc-035'], ['idfc-043', 'idfc-034'], ['idfc-046', 'idfc-045']];
  for (const [si, sp] of trios) {
    it(`card trio ${si} (paid) + ${sp} (spend), both orders`, () => {
      const paid = parsed(si);
      const spend = parsed(sp);
      expect(paid.kind).toBe('card_si_paid');
      expect(spend.kind).toBe('card_spend');
      expect(correlate([pending(paid, 'p1')], spend)).toEqual({
        action: 'enrich', target: 'p1', patch: { occurredTime: spend.occurredTime },
      });
      expect(correlate([pending(spend, 'p2')], paid)).toEqual({ action: 'drop_duplicate', of: 'p2', reason: 'paired' });
    });
  }

  it('unrelated card charges do not match', () => {
    expect(correlate([pending(parsed('idfc-041'), 'p1')], parsed('idfc-045'))).toEqual({ action: 'insert' });
  });
});

describe('correlate (review fixes)', () => {
  const card = (o: Partial<ParsedTxn>) =>
    mk({ kind: 'card_spend', accountType: 'card', accountLast4: '3455', occurredTime: '10:00', merchant: 'Facebook', amountMinor: 224071, ...o });

  const pairs: [string, string][] = [
    ['idfc-010', 'idfc-018'], ['idfc-012', 'idfc-019'], ['idfc-013', 'idfc-020'],
    ['idfc-014', 'idfc-023'], ['idfc-015', 'idfc-024'],
  ];
  for (const [d, n] of pairs) {
    it(`confirm ${n} first, then debit ${d}`, () => {
      const deb = parsed(d);
      const conf = parsed(n);
      const r = correlate([pending(conf, 'p1')], deb);
      expect(r.action).toBe('enrich');
      if (r.action === 'enrich') {
        expect(r.target).toBe('p1');
        expect(r.patch.kind).toBe('ca_debit');
        expect(r.patch.occurredOn).toBe(deb.occurredOn);
        expect(r.patch.accountLast4).toBe(deb.accountLast4);
        expect(r.patch.balanceMinor).toBe(deb.balanceMinor);
        expect(r.patch.occurredTime).toBe(deb.occurredTime ?? undefined);
      }
    });
  }

  it('prefers exact utr match over an earlier amount-only candidate', () => {
    const a = pending(mk({ rawHash: 'a', amountMinor: 5000 }), 'A');
    const b = pending(mk({ rawHash: 'b', amountMinor: 5000, utr: 'U1' }), 'B');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'c', amountMinor: 5000, utr: 'U1', counterparty: 'X' });
    expect(correlate([a, b], inc)).toMatchObject({ action: 'enrich', target: 'B' });
  });

  it('fallback picks the nearest in time, ties by lowest id', () => {
    const far = pending(mk({ rawHash: 'a' }), 'A');
    const near = pending(mk({ rawHash: 'b', receivedAt: base.receivedAt + 10 * H }), 'B');
    const inc = mk({ kind: 'neft_confirm', rawHash: 'c', utr: 'U1', receivedAt: base.receivedAt + 11 * H });
    expect(correlate([far, near], inc)).toMatchObject({ target: 'B' });
    const t1 = pending(mk({ rawHash: 'a', receivedAt: base.receivedAt - H }), 'Z');
    const t2 = pending(mk({ rawHash: 'b', receivedAt: base.receivedAt + H }), 'M');
    expect(correlate([t1, t2], mk({ kind: 'neft_confirm', rawHash: 'c', utr: 'U1' }))).toMatchObject({ target: 'M' });
  });

  it('case A: a second equal-amount SMS inserts once the item is already paired', () => {
    const spend = card({ rawHash: 'a' });
    const siPaid = card({ kind: 'card_si_paid', occurredTime: null, rawHash: 'b' });
    expect(correlate([pending(spend, 'p1')], siPaid)).toEqual({ action: 'drop_duplicate', of: 'p1', reason: 'paired' });
    // pipeline incremented mergedCount to 2
    expect(correlate([pending(spend, 'p1', 'new', 2)], card({ kind: 'card_si_paid', rawHash: 'c' }))).toEqual({ action: 'insert' });
  });

  it('case B: a second equal-amount spend inserts after si_paid + spend merged', () => {
    const merged = pending(card({ kind: 'card_si_paid', rawHash: 'a' }), 'p1', 'new', 2);
    expect(correlate([merged], card({ rawHash: 'c' }))).toEqual({ action: 'insert' });
  });

  it('merged neft items accept no further pairing', () => {
    const ex = pending(base, 'p1', 'new', 2);
    expect(correlate([ex], mk({ kind: 'neft_confirm', rawHash: 'h2', utr: 'U1' }))).toEqual({ action: 'insert' });
  });

  it('short merchant containment does not match', () => {
    const e1 = pending(card({ kind: 'card_si_paid', merchant: 'pay', rawHash: 'a' }), 'p1');
    expect(correlate([e1], card({ merchant: 'amazonpay', rawHash: 'b' }))).toEqual({ action: 'insert' });
    const e2 = pending(card({ kind: 'card_si_paid', merchant: 'mi', rawHash: 'a' }), 'p2');
    expect(correlate([e2], card({ merchant: 'zomatomix', rawHash: 'b' }))).toEqual({ action: 'insert' });
  });
});
