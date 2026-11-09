// Which answers a transaction can have (spec section 8 / 9) and the order of the questions that follow.
// Pure. The planner throws PlanError('bad_direction') for an impossible pair; these lists never offer one.
// A credit's transfer uses `fromAccount` (any ERPNext Bank Account), a debit's uses `toAccount` (a mapping).
import type { ActionChoice, PartyRef, PendingTxn } from '../core/types';
import type { FlowDraft } from './flow';

export type ActionType = ActionChoice['type'];
export type ActionItem = { type: ActionType; label: string; hint: string };

const PE = 'Creates a draft payment entry.';
const JE = 'Creates a draft journal entry.';

const CREDIT: ActionItem[] = [
  { type: 'customer_advance', label: 'Customer advance', hint: `Money from a customer before an invoice. ${PE}` },
  { type: 'against_invoice', label: 'Payment against an invoice', hint: `A customer paid one or more open invoices. ${PE}` },
  { type: 'other_income', label: 'Other income', hint: `Interest, refunds and other income. ${JE}` },
  { type: 'transfer', label: 'Transfer from my other account', hint: `Money moved in from another of your accounts. ${PE}` },
  { type: 'personal', label: 'Personal', hint: `Your own money put into the business. ${JE}` },
  { type: 'ignore', label: 'Ignore this message', hint: 'Nothing is added to ERPNext.' },
];
const BANK_DEBIT: ActionItem[] = [
  { type: 'supplier_payment', label: 'Supplier payment', hint: `A payment or advance to a supplier. ${PE}` },
  { type: 'against_invoice', label: 'Payment against a bill', hint: `You paid one or more open supplier bills. ${PE}` },
  { type: 'expense', label: 'Expense', hint: `A cost with no bill in ERPNext. ${JE}` },
  { type: 'salary', label: 'Salary/Employee payment', hint: `Salary or other money paid to an employee. ${PE}` },
  { type: 'transfer', label: 'Transfer between my accounts', hint: `Including paying the credit card bill. ${PE}` },
  { type: 'personal', label: 'Personal', hint: `Money you took out for yourself. ${JE}` },
  { type: 'ignore', label: 'Ignore this message', hint: 'Nothing is added to ERPNext.' },
];
const CARD_DEBIT: ActionItem[] = [
  { type: 'expense', label: 'Expense', hint: `A card spend with no bill in ERPNext. ${JE}` },
  { type: 'bill_paid_by_card', label: 'Bill paid by card', hint: `You paid an open supplier bill with the card. ${PE}` },
  { type: 'personal', label: 'Personal', hint: `A personal spend on the business card. ${JE}` },
  { type: 'ignore', label: 'Ignore this message', hint: 'Nothing is added to ERPNext.' },
];

export function actionsFor(direction: 'in' | 'out', kind: 'bank' | 'card'): ActionItem[] {
  if (direction === 'in') return CREDIT;
  return kind === 'card' ? CARD_DEBIT : BANK_DEBIT;
}

export function actionLabel(type: ActionType, direction: 'in' | 'out', kind: 'bank' | 'card'): string {
  return actionsFor(direction, kind).find((a) => a.type === type)?.label ?? type;
}

export function partyDoctypeFor(type: ActionType, direction: 'in' | 'out'): PartyRef['doctype'] | null {
  switch (type) {
    case 'customer_advance': return 'Customer';
    case 'against_invoice': return direction === 'in' ? 'Customer' : 'Supplier';
    case 'supplier_payment': case 'bill_paid_by_card': case 'expense': return 'Supplier';
    case 'salary': return 'Employee';
    default: return null;
  }
}

export type Step = 'choose' | 'amount' | 'party' | 'order' | 'invoices' | 'account' | 'confirm';

/** The next question for this draft, or 'confirm' when every answer is in. */
export function nextStep(txn: PendingTxn, d: FlowDraft): Step {
  const a = d.action;
  if (!a) return 'choose';
  if (a !== 'ignore' && txn.currency !== 'INR' && d.inrAmountMinor === undefined) return 'amount';
  switch (a) {
    case 'customer_advance':
      if (!d.party) return 'party';
      // A new customer has no Sales Orders yet; otherwise ask which order (or none) once.
      return d.newParty || d.orders ? 'confirm' : 'order';
    case 'supplier_payment': case 'salary':
      return d.party ? 'confirm' : 'party';
    case 'against_invoice': case 'bill_paid_by_card':
      if (!d.party) return 'party';
      return d.invoices && d.invoices.length > 0 ? 'confirm' : 'invoices';
    case 'expense': case 'other_income':
      return d.account ? 'confirm' : 'account';
    case 'transfer':
      return (txn.direction === 'in' ? d.fromAccount : d.toAccount) ? 'confirm' : 'account';
    default:
      return 'confirm';
  }
}

const NOT_REMEMBERED: ReadonlySet<ActionType> = new Set(['against_invoice', 'bill_paid_by_card', 'transfer']);
/** Whether the confirm screen offers "Remember this choice" (learnRule never learns the others). */
export const rememberShown = (t: ActionType) => !NOT_REMEMBERED.has(t);
export const rememberDefault = (t: ActionType) => rememberShown(t);
