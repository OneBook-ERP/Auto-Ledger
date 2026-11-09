// Classifier (wave 3 K): groups of similar pending items, and the guard for answering one automatically. Pure.
// Pattern = the exact normalised name key from suggest (counterparty, else merchant, plus direction). Never a
// substring or fuzzy match: "facebook" and "facebookads pvt" are different patterns.
import { nameKey, ruleChoice } from './suggest';
import type { ActionChoice, PendingTxn, Rule } from './types';

/** The only answers that may be given in bulk or automatically. Everything else is always answered one by one. */
export const AUTO_ACTIONS: ReadonlySet<ActionChoice['type']> = new Set(['expense', 'supplier_payment', 'other_income', 'personal', 'ignore']);

/** How far above the largest confirmed amount an automatic answer may go (inclusive). */
export const AUTO_MAX_FACTOR = 2;

const RUPEE = 'INR';

export type SimilarGroup = { key: string; items: PendingTxn[]; suggestion: Partial<ActionChoice> | null };

/** The direction an answer needs, or null when it fits either. */
function neededDirection(action: ActionChoice['type']): 'in' | 'out' | null {
  switch (action) {
    case 'expense': case 'supplier_payment': case 'salary': case 'bill_paid_by_card': return 'out';
    case 'other_income': case 'customer_advance': return 'in';
    default: return null;
  }
}

/**
 * Pending items sharing one pattern, groups of 2 or more only, largest group first (then by key). Items keep their
 * input order. `suggestion` is the complete answer of the rule stored for exactly this pattern, else null.
 */
export function groupSimilar(items: PendingTxn[], rules: Rule[]): SimilarGroup[] {
  const byKey = new Map<string, PendingTxn[]>();
  for (const t of items) {
    const k = nameKey(t);
    if (!k) continue;
    const list = byKey.get(k);
    if (list) list.push(t);
    else byKey.set(k, [t]);
  }
  const out: SimilarGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    const rule = rules.find((r) => r.matchKey === key && ruleChoice(r) !== null);
    out.push({ key, items: list, suggestion: rule ? ruleChoice(rule) : null });
  }
  out.sort((a, b) => b.items.length - a.items.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out;
}

/**
 * True only when the app may answer `txn` with `rule` without asking: the user switched the rule to automatic,
 * its answer is complete and one of the allowed five, the item is still waiting, its pattern is exactly the
 * rule's, the answer fits the money's direction, it is a rupee amount no more than twice the largest amount the
 * user confirmed for this rule, and it has no "may already be booked" warning.
 */
export function canAutoApply(txn: PendingTxn, rule: Rule, dupFlag: boolean): boolean {
  if (dupFlag) return false;
  if (rule.auto !== true) return false;
  if (!AUTO_ACTIONS.has(rule.action)) return false;
  if (ruleChoice(rule) === null) return false;
  if (txn.state !== 'new') return false;
  const key = nameKey(txn);
  if (key === null || key !== rule.matchKey) return false;
  const dir = neededDirection(rule.action);
  if (dir !== null && dir !== txn.direction) return false;
  if (txn.currency !== RUPEE || rule.currency !== RUPEE) return false;
  const max = rule.maxAmountMinor;
  if (max === undefined || !Number.isSafeInteger(max) || max <= 0) return false;
  if (!Number.isSafeInteger(txn.amountMinor) || txn.amountMinor <= 0) return false;
  return txn.amountMinor <= AUTO_MAX_FACTOR * max;
}
