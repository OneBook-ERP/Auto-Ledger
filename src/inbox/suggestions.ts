// Turning core/suggest results into what the Inbox and the Transaction screen show. Pure.
import type { ActionChoice, PartyRef, PendingTxn, Suggestion } from '../core/types';
import { actionsFor } from './actions';
import type { FlowDraft } from './flow';
import { shortAccount } from './format';

export type ChipTone = 'accent' | 'warn' | 'plain';
export type ChipView = { text: string; tone: ChipTone };

type Choice = Partial<ActionChoice> & { type?: ActionChoice['type'] };
const get = <T,>(c: Choice, k: string): T | undefined => (c as Record<string, unknown>)[k] as T | undefined;

function briefly(c: Choice, direction: 'in' | 'out'): string {
  switch (c.type) {
    case 'customer_advance': return 'customer advance';
    case 'supplier_payment': return 'supplier payment';
    case 'salary': return 'salary';
    case 'expense': return shortAccount(get<string>(c, 'expenseAccount') ?? 'expense');
    case 'other_income': return 'other income';
    case 'personal': return 'personal';
    case 'ignore': return 'ignore';
    case 'against_invoice': return direction === 'in' ? 'payment against an invoice' : 'payment against a bill';
    case 'bill_paid_by_card': return 'bill paid by card';
    case 'transfer': return 'transfer';
    default: return 'see options';
  }
}

/** The Inbox row chip. A foreign-currency spend always asks for the rupee amount first. */
export function chipFor(txn: PendingTxn, suggestions: Suggestion[]): ChipView {
  if (txn.currency !== 'INR') return { text: 'Enter the rupee amount', tone: 'warn' };
  const top = suggestions[0];
  if (!top) return { text: 'Who is this?', tone: 'plain' };
  const prefix = top.reason === 'rule' ? 'You did this before' : 'Suggested';
  return { text: `${prefix}: ${briefly(top.choice, txn.direction)}`, tone: 'accent' };
}

/** Only suggestions this transaction can actually take (account kind, direction, drawings set). */
export function usableSuggestions(txn: PendingTxn, s: Suggestion[], o: { drawings: boolean }): Suggestion[] {
  const allowed = new Set(actionsFor(txn.direction, txn.accountType).map((a) => a.type));
  return s.filter((x) => x.choice.type && allowed.has(x.choice.type) && (x.choice.type !== 'personal' || o.drawings));
}

const REASON: Record<Suggestion['reason'], string> = {
  rule: 'You did this before.',
  utr: 'Same reference as before.',
  exact_invoice_amount: 'Same amount as an open invoice.',
  name_match: 'Matched by name.',
};

function creates(t: ActionChoice['type'] | undefined): string {
  if (t === 'ignore') return 'Nothing is added to ERPNext.';
  if (t === 'expense' || t === 'other_income' || t === 'personal') return 'Creates a draft journal entry.';
  return 'Creates a draft payment entry.';
}

/** The primary option on the Transaction screen. */
export function suggestionCard(s: Suggestion, party?: PartyRef & { displayName?: string }): { title: string; subtitle: string } {
  const c = s.choice;
  const p = get<PartyRef>(c, 'party') ?? party;
  const who = p ? (party?.name === p.name && party.displayName ? party.displayName : p.name) : '';
  let title: string;
  switch (c.type) {
    case 'customer_advance': title = `Advance from ${who}`; break;
    case 'supplier_payment': title = `Payment to ${who}`; break;
    case 'salary': title = `Salary to ${who}`; break;
    case 'expense': title = `Expense: ${shortAccount(get<string>(c, 'expenseAccount') ?? '')}`; break;
    case 'other_income': title = `Other income: ${shortAccount(get<string>(c, 'incomeAccount') ?? '')}`; break;
    case 'personal': title = 'Personal'; break;
    case 'ignore': title = 'Ignore this message'; break;
    case 'against_invoice': {
      const names = (get<{ name: string }[]>(c, 'invoices') ?? []).map((i) => i.name).join(', ');
      title = who ? `${who}: against ${names}` : `Against ${names}`;
      break;
    }
    default: title = 'Suggested answer';
  }
  return { title, subtitle: `${REASON[s.reason]} ${creates(c.type)}` };
}

/** Pre-filled answers for the flow when the user takes a suggestion. `party` fills an invoice match. */
export function draftFromSuggestion(s: Suggestion, party?: PartyRef): FlowDraft {
  const c = s.choice;
  const d: FlowDraft = { action: c.type };
  const p = get<PartyRef>(c, 'party') ?? (c.type === 'against_invoice' ? party : undefined);
  if (p) d.party = p;
  const acc = get<string>(c, 'expenseAccount') ?? get<string>(c, 'incomeAccount');
  if (acc !== undefined) d.account = acc;
  const inv = get<FlowDraft['invoices']>(c, 'invoices');
  if (inv) d.invoices = inv;
  return d;
}
