// Pure helpers for scripts/pilot-parse-rate.ts (spec section 17: >= 95% of pilot-bank SMS parsed correctly).
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
  money: { total: number; correct: number; percent: number };
  ignored: { total: number; correct: number };
  /** Ids of fixtures whose parse did not match what the fixture expects. */
  failures: string[];
  /** True when at least one money fixture exists and the percentage is >= TARGET_PERCENT. */
  meetsTarget: boolean;
};

export const TARGET_PERCENT = 95;

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
  let moneyTotal = 0, moneyCorrect = 0, ignoredTotal = 0, ignoredCorrect = 0;
  for (const f of fixtures) {
    const key = f.expected.ok ? String(f.expected.txn.kind) : `ignore:${f.expected.reason}`;
    perKind[key] = (perKind[key] ?? 0) + 1;
    const ok = matches(f, parse(f.sender, f.body, f.receivedAt, templates));
    if (f.expected.ok) {
      moneyTotal++;
      if (ok) moneyCorrect++;
    } else {
      ignoredTotal++;
      if (ok) ignoredCorrect++;
    }
    if (!ok) failures.push(f.id);
  }
  const percent = moneyTotal === 0 ? 0 : Math.round((moneyCorrect / moneyTotal) * 1000) / 10;
  return {
    total: fixtures.length,
    perKind,
    money: { total: moneyTotal, correct: moneyCorrect, percent },
    ignored: { total: ignoredTotal, correct: ignoredCorrect },
    failures,
    meetsTarget: moneyTotal > 0 && percent >= TARGET_PERCENT,
  };
}

export function formatReport(r: RateReport): string {
  const lines = [`fixtures: ${r.total}`, 'expected category counts:'];
  for (const [k, n] of Object.entries(r.perKind).sort()) lines.push(`  ${k}: ${n}`);
  lines.push(`money fixtures parsed to expected values: ${r.money.correct}/${r.money.total} (${r.money.percent}%), target >= ${TARGET_PERCENT}%`);
  lines.push(`ignore fixtures dropped for the expected reason: ${r.ignored.correct}/${r.ignored.total}`);
  if (r.failures.length) lines.push(`mismatches: ${r.failures.join(', ')}`);
  lines.push(r.meetsTarget ? 'RESULT: target met' : 'RESULT: target NOT met');
  return lines.join('\n');
}
