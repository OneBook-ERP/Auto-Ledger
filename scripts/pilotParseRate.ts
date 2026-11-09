// Pure helpers for scripts/pilot-parse-rate.ts (spec section 17: >= 95% of pilot-bank SMS parsed correctly).
//
// Denominators. "Money fixtures" are fixtures whose expected result is ok:true AND whose kind is one of
// ca_credit, ca_debit, neft_confirm, card_spend, card_si_paid. Fixtures expecting ok:false (OTP, SI notice,
// not_money, unknown_template) are EXCLUDED from the rate and counted separately as "ignored". This biases the
// rate upward: a real money SMS in an unknown format that the fixtures do not contain cannot lower it, and the
// fixtures were written from the templates. A second figure, `allOk`, is the parse rate over ALL fixtures whose
// expected is ok:true (any kind). The target is compared against the UNROUNDED money ratio (94.96% fails);
// `percent` is rounded to one decimal for display only.

import type { ParseResult, TemplateSet } from '../src/core/types';

export type Fixture = {
  id: string;
  sender: string;
  body: string;
  receivedAt: number;
  expected: { ok: true; txn: Record<string, unknown> } | { ok: false; reason: string };
};
export type ParseFn = (sender: string, body: string, receivedAt: number, templates: TemplateSet) => ParseResult;

export type RateReport = {
  total: number;
  /** Count of fixtures per expected category: the txn kind, or `ignore:<reason>`. */
  perKind: Record<string, number>;
  money: { total: number; correct: number; percent: number; ratio: number };
  /** Parse rate over ALL fixtures whose expected is ok:true. */
  allOk: { total: number; correct: number; percent: number };
  ignored: { total: number; correct: number };
  /** Ids of fixtures whose parse did not match what the fixture expects. */
  failures: string[];
  /** True when at least one money fixture exists and the percentage is >= TARGET_PERCENT. */
  meetsTarget: boolean;
};

export const TARGET_PERCENT = 95;
const MONEY_KINDS = new Set(['ca_credit', 'ca_debit', 'neft_confirm', 'card_spend', 'card_si_paid']);

function matches(f: Fixture, r: ParseResult): boolean {
  if (!f.expected.ok) return !r.ok && r.reason === f.expected.reason;
  if (!r.ok) return false;
  const actual = r.txn as unknown as Record<string, unknown>;
  return Object.entries(f.expected.txn).every(([k, v]) => actual[k] === v);
}

/** Runs every fixture through `parse` and counts. A money fixture is correct only when every field it lists matches. */
export function evaluateFixtures(fixtures: readonly Fixture[], templates: TemplateSet, parse: ParseFn): RateReport {
  const perKind: Record<string, number> = {};
  const failures: string[] = [];
  let allOkTotal = 0, allOkCorrect = 0, moneyTotal = 0, moneyCorrect = 0, ignoredTotal = 0, ignoredCorrect = 0;
  for (const f of fixtures) {
    const key = f.expected.ok ? String(f.expected.txn.kind) : `ignore:${f.expected.reason}`;
    perKind[key] = (perKind[key] ?? 0) + 1;
    const ok = matches(f, parse(f.sender, f.body, f.receivedAt, templates));
    if (f.expected.ok) {
      allOkTotal++;
      if (ok) allOkCorrect++;
      if (MONEY_KINDS.has(String(f.expected.txn.kind))) {
        moneyTotal++;
        if (ok) moneyCorrect++;
      }
    } else {
      ignoredTotal++;
      if (ok) ignoredCorrect++;
    }
    if (!ok) failures.push(f.id);
  }
  const ratio = moneyTotal === 0 ? 0 : moneyCorrect / moneyTotal;
  const percent = Math.round(ratio * 1000) / 10;
  return {
    total: fixtures.length,
    perKind,
    money: { total: moneyTotal, correct: moneyCorrect, percent, ratio },
    allOk: { total: allOkTotal, correct: allOkCorrect, percent },
    ignored: { total: ignoredTotal, correct: ignoredCorrect },
    failures,
    meetsTarget: moneyTotal > 0 && ratio * 100 >= TARGET_PERCENT,
  };
}

export function formatReport(r: RateReport): string {
  const lines = [`fixtures: ${r.total}`, 'expected category counts:'];
  for (const [k, n] of Object.entries(r.perKind).sort()) lines.push(`  ${k}: ${n}`);
  lines.push(`money fixtures parsed to expected values: ${r.money.correct}/${r.money.total} (${r.money.percent}% rounded; unrounded ${(r.money.ratio * 100).toFixed(4)}%), target >= ${TARGET_PERCENT}%`);
  lines.push(`parse rate over all fixtures whose expected is ok:true: ${r.allOk.correct}/${r.allOk.total} (${r.allOk.percent}%)`);
  lines.push(`ignore fixtures dropped for the expected reason: ${r.ignored.correct}/${r.ignored.total}`);
  if (r.failures.length) lines.push(`mismatches: ${r.failures.join(', ')}`);
  lines.push(r.meetsTarget ? 'RESULT: target met' : 'RESULT: target NOT met');
  return lines.join('\n');
}
