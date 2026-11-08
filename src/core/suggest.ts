// Suggestions and learned rules (spec 7.5-7.8). Pure; phase 1 never auto-posts,
// so a Suggestion carries only {choice, reason, confidence}.
import type { ActionChoice, OpenInvoice, PartyRef, PendingTxn, Rule, Suggestion } from './types';

const MAX_SUGGESTIONS = 5;
const NAME_THRESHOLD = 0.6;
const LEGAL_SUFFIXES = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'co', 'company', 'corp', 'corporation', 'the']);
const REASON_PRIORITY: Record<Suggestion['reason'], number> = { utr: 0, rule: 1, exact_invoice_amount: 2, name_match: 3 };
const NOT_LEARNED: ReadonlySet<ActionChoice['type']> = new Set(['against_invoice', 'bill_paid_by_card']);

export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function nameKey(txn: PendingTxn): string | null {
  const text = txn.counterparty ?? txn.merchant;
  if (!text) return null;
  const norm = normalizeKey(text);
  if (!norm) return null;
  return `${txn.counterparty ? 'cp' : 'm'}:${txn.direction}:${norm}`;
}
function utrKey(txn: PendingTxn): string | null {
  return txn.utr ? `utr:${txn.utr}` : null;
}

function ruleChoice(rule: Rule): Partial<ActionChoice> {
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
  for (const t of s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/)) {
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

type Ranked = Suggestion & { _party: string };

export function suggest(txn: PendingTxn, rules: Rule[], openInvoices: OpenInvoice[], parties: PartyRef[]): Suggestion[] {
  const out: Ranked[] = [];

  const uKey = utrKey(txn);
  const nKey = nameKey(txn);
  for (const r of rules) {
    const isUtr = uKey !== null && r.matchKey === uKey;
    if (!isUtr && !(nKey !== null && r.matchKey === nKey)) continue;
    out.push({
      choice: ruleChoice(r), reason: isUtr ? 'utr' : 'rule',
      confidence: isUtr ? 1 : Math.min(0.99, 0.8 + 0.02 * r.hits),
      _party: r.party?.name ?? '',
    });
  }

  const credit = txn.direction === 'in';
  const wanted = credit ? 'Sales Invoice' : 'Purchase Invoice';
  const exact = openInvoices.filter((i) => i.doctype === wanted && i.outstandingMinor === txn.amountMinor);
  if (exact.length === 1) {
    out.push({
      choice: { type: 'against_invoice', invoices: [{ doctype: wanted, name: exact[0].name, allocatedMinor: txn.amountMinor }] },
      reason: 'exact_invoice_amount', confidence: 0.75, _party: '',
    });
  }

  if (txn.counterparty) {
    const cpTokens = tokens(txn.counterparty);
    for (const p of parties) {
      if (credit ? p.doctype !== 'Customer' : p.doctype === 'Customer') continue;
      const score = jaccard(cpTokens, tokens(p.name));
      if (score < NAME_THRESHOLD) continue;
      const type = credit ? 'customer_advance' : p.doctype === 'Employee' ? 'salary' : 'supplier_payment';
      out.push({ choice: { type, party: p } as Partial<ActionChoice>, reason: 'name_match', confidence: Math.round(score * 0.7 * 100) / 100, _party: p.name });
    }
  }

  out.sort((a, b) =>
    b.confidence - a.confidence ||
    REASON_PRIORITY[a.reason] - REASON_PRIORITY[b.reason] ||
    (a._party < b._party ? -1 : a._party > b._party ? 1 : 0));

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

export function learnRule(txn: PendingTxn, choice: ActionChoice, existing: Rule[]): Rule[] {
  if (NOT_LEARNED.has(choice.type)) return existing;
  const key = nameKey(txn) ?? utrKey(txn);
  if (!key) return existing;

  const party = 'party' in choice ? choice.party : undefined;
  const account = choice.type === 'expense' ? choice.expenseAccount : choice.type === 'other_income' ? choice.incomeAccount : undefined;
  const idx = existing.findIndex((r) => r.matchKey === key && r.action === choice.type);
  const next = existing.slice();
  if (idx >= 0) {
    const old = existing[idx];
    const updated: Rule = { matchKey: key, action: choice.type, hits: old.hits + 1, lastUsed: txn.receivedAt };
    if (party) updated.party = party;
    if (account !== undefined) updated.account = account;
    next[idx] = updated;
  } else {
    const created: Rule = { matchKey: key, action: choice.type, hits: 1, lastUsed: txn.receivedAt };
    if (party) created.party = party;
    if (account !== undefined) created.account = account;
    next.push(created);
  }
  return next;
}
