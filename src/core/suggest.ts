// Suggestions and learned rules (spec 7.5-7.8). Pure; phase 1 never auto-posts,
// so a Suggestion carries only {choice, reason, confidence}.
import type { ActionChoice, OpenInvoice, PartyRef, PendingTxn, Rule, Suggestion } from './types';

const MAX_SUGGESTIONS = 5;
const NAME_THRESHOLD = 0.6;
const LEGAL_SUFFIXES = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'corporation', 'the']);
const REASON_PRIORITY: Record<Suggestion['reason'], number> = { utr: 0, rule: 1, exact_invoice_amount: 2, name_match: 3 };
const NOT_LEARNED: ReadonlySet<ActionChoice['type']> = new Set(['against_invoice', 'bill_paid_by_card', 'transfer']);

export function normalizeKey(s: string): string {
  const k = s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}]/gu, '');
  return /[\p{L}\p{N}]/u.test(k) ? k : '';
}

/** The pattern of a txn: normalised counterparty (else merchant) plus direction; null when it has no name. */
export function nameKey(txn: PendingTxn): string | null {
  const cp = txn.counterparty ? normalizeKey(txn.counterparty) : '';
  if (cp) return `cp:${txn.direction}:${cp}`;
  const m = txn.merchant ? normalizeKey(txn.merchant) : '';
  return m ? `m:${txn.direction}:${m}` : null;
}
function utrKey(txn: PendingTxn): string | null {
  return txn.utr ? `utr:${txn.utr}` : null;
}

// A rule yields a suggestion only if it can produce a complete choice for the planner.
export function ruleChoice(rule: Rule): Partial<ActionChoice> | null {
  switch (rule.action) {
    case 'customer_advance': case 'supplier_payment': case 'salary':
      if (!rule.party) return null; break;
    case 'expense': case 'other_income':
      if (!rule.account) return null; break;
    case 'personal': case 'ignore': break;
    default: return null;
  }
  const c: Record<string, unknown> = { type: rule.action };
  if (rule.party) c.party = rule.party;
  if (rule.account !== undefined) {
    if (rule.action === 'expense') c.expenseAccount = rule.account;
    else if (rule.action === 'other_income') c.incomeAccount = rule.account;
  }
  return c as Partial<ActionChoice>;
}

function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s]/gu, ' ').split(/\s+/)) {
    if (t && !LEGAL_SUFFIXES.has(t)) out.add(t);
  }
  return out;
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

type Ranked = Suggestion & { _party: string; _doctype: string };

export function suggest(txn: PendingTxn, rules: Rule[], openInvoices: OpenInvoice[], parties: PartyRef[]): Suggestion[] {
  const out: Ranked[] = [];

  const uKey = utrKey(txn);
  const nKey = nameKey(txn);
  for (const r of rules) {
    const isUtr = uKey !== null && r.matchKey === uKey;
    if (!isUtr && !(nKey !== null && r.matchKey === nKey)) continue;
    const choice = ruleChoice(r);
    if (!choice) continue;
    out.push({
      choice, reason: isUtr ? 'utr' : 'rule',
      confidence: isUtr ? 1 : Math.min(0.99, 0.8 + 0.02 * r.hits),
      _party: r.party?.name ?? '', _doctype: r.party?.doctype ?? '',
    });
  }

  const credit = txn.direction === 'in';
  const wanted = credit ? 'Sales Invoice' : 'Purchase Invoice';
  const exact = openInvoices.filter((i) => i.doctype === wanted && i.outstandingMinor === txn.amountMinor);
  if (exact.length === 1) {
    out.push({
      choice: { type: 'against_invoice', invoices: [{ doctype: wanted, name: exact[0].name, allocatedMinor: txn.amountMinor }] },
      reason: 'exact_invoice_amount', confidence: 0.75, _party: '', _doctype: '',
    });
  }

  if (txn.counterparty) {
    const cpTokens = tokens(txn.counterparty);
    for (const p of parties) {
      if (credit ? p.doctype !== 'Customer' : p.doctype === 'Customer') continue;
      const score = jaccard(cpTokens, tokens(p.name));
      if (score < NAME_THRESHOLD) continue;
      const type = credit ? 'customer_advance' : p.doctype === 'Employee' ? 'salary' : 'supplier_payment';
      out.push({ choice: { type, party: p } as Partial<ActionChoice>, reason: 'name_match', confidence: Math.round(score * 0.7 * 100) / 100, _party: p.name, _doctype: p.doctype });
    }
  }

  out.sort((a, b) =>
    b.confidence - a.confidence ||
    REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason] ||
    (a._party < b._party ? -1 : a._party > b._party ? 1 : 0) ||
    (a._doctype < b._doctype ? -1 : a._doctype > b._doctype ? 1 : 0));

  const seen = new Set<string>();
  const result: Suggestion[] = [];
  for (const s of out) {
    const k = JSON.stringify(s.choice);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push({ choice: s.choice, reason: s.reason, confidence: s.confidence });
    if (result.length === MAX_SUGGESTIONS) break;
  }
  return result;
}

const RUPEE = 'INR';

/**
 * Records the answer for this txn's pattern. Same answer as the stored rule (same action, party and account): hits
 * go up, the automatic switch is kept and the largest confirmed rupee amount is raised when this one is larger.
 * A changed answer starts over: not automatic, and only this amount counts. `raiseMax: false` (an answer the app
 * made by itself) counts the use but never raises the amount, so automatic answers cannot widen their own limit.
 */
export function learnRule(txn: PendingTxn, choice: ActionChoice, existing: Rule[], opts: { raiseMax?: boolean } = {}): Rule[] {
  if (NOT_LEARNED.has(choice.type)) return existing;
  const key = nameKey(txn) ?? utrKey(txn);
  if (!key) return existing;

  const party = 'party' in choice ? choice.party : undefined;
  const account = choice.type === 'expense' ? choice.expenseAccount : choice.type === 'other_income' ? choice.incomeAccount : undefined;
  const raise = opts.raiseMax !== false;
  const confirmed = raise && txn.currency === RUPEE && Number.isSafeInteger(txn.amountMinor) && txn.amountMinor > 0
    ? txn.amountMinor : null;
  const idx = existing.findIndex((r) => r.matchKey === key && r.action === choice.type);
  const next = existing.slice();
  const rule: Rule = { matchKey: key, action: choice.type, hits: 1, lastUsed: txn.receivedAt };
  if (party) rule.party = party;
  if (account !== undefined) rule.account = account;
  let max: number | null = confirmed;
  if (idx >= 0) {
    const old = existing[idx];
    rule.hits = old.hits + 1;
    const same = JSON.stringify(old.party ?? null) === JSON.stringify(party ?? null) && (old.account ?? null) === (account ?? null);
    if (same) {
      if (old.auto) rule.auto = true;
      const oldMax = old.currency === RUPEE && old.maxAmountMinor !== undefined ? old.maxAmountMinor : null;
      max = oldMax === null ? confirmed : confirmed === null ? oldMax : Math.max(oldMax, confirmed);
    }
  }
  if (max !== null) {
    rule.maxAmountMinor = max;
    rule.currency = RUPEE;
  }
  if (idx >= 0) next[idx] = rule;
  else next.push(rule);
  return next;
}
