// The answers collected across the action flow (FlowDraft) and how they become an ActionChoice, a PlanContext
// and an ActionPlan. Pure: the screens only collect answers; everything that decides money lives here.
import { PlanError, planAction, type PlanContext } from '../core/plan';
import type { AccountMapping, ActionChoice, ActionPlan, PartyRef, PendingTxn } from '../core/types';
import { formatInr } from '../ui/format';
import type { ActionType } from './actions';

export type InvoicePick = { doctype: 'Sales Invoice' | 'Purchase Invoice'; name: string; allocatedMinor: number };
export type NewParty = { ref: PartyRef; fields: Record<string, unknown> };

export type FlowDraft = {
  /** The saved account the message belongs to (resolved, or picked by the user). */
  mapping?: AccountMapping;
  action?: ActionType;
  /** The party of the action; for an expense the optional supplier. */
  party?: PartyRef & { displayName?: string };
  newParty?: NewParty;
  invoices?: InvoicePick[];
  /** Expense or income ledger account. */
  account?: string;
  toAccount?: AccountMapping;
  /** Rupee value of a foreign-currency spend, in paise. */
  inrAmountMinor?: number;
};

export type FlowSettings = { company: string; drawingsAccount: string; today: string };

export const IGNORE_NOTE = 'Nothing will be added to ERPNext. AutoLedger will not ask about this message again.';
/** A credit cannot be booked as the Internal Transfer (the planner books a transfer from the account the money left). */
export const TRANSFER_IN_NOTE =
  'Nothing will be added to ERPNext for this message. A transfer is booked once, from the account the money left: answer that account\'s message as "Transfer between my accounts". If that account does not send messages to AutoLedger, your accountant books the transfer from its statement.';

/** "8,500.50" -> 850050 paise. Null for anything that is not a positive amount with at most 2 decimals. */
export function parseRupees(text: string): number | null {
  const s = text.replace(/[,\s₹]/g, '');
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** 850050 -> "8500.50" (for an editable field). */
export function toPaise(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}

/** The rupee amount the documents will carry; null while a foreign spend has no rupee value yet. */
export function effectiveAmountMinor(txn: PendingTxn, d: Pick<FlowDraft, 'inrAmountMinor'>): number | null {
  if (txn.currency === 'INR') return txn.amountMinor;
  return d.inrAmountMinor ?? null;
}

const NAME_FIELD: Record<PartyRef['doctype'], string> = { Customer: 'customer_name', Supplier: 'supplier_name', Employee: 'first_name' };
/** Fields the party form never asks for separately (the name, or ones ERPNext derives from it). */
const HIDDEN_FIELDS = new Set(['customer_name', 'supplier_name', 'first_name', 'employee_name', 'naming_series']);
const LAYOUT_TYPES = new Set(['Section Break', 'Column Break', 'Tab Break', 'HTML', 'Button', 'Heading', 'Table', 'Table MultiSelect', 'Fold']);

export type RequiredField = { fieldname: string; label: string; fieldtype: string };

/** Required fields (from getRequiredFields) the form must ask for besides the name. */
export function extraFields(required: RequiredField[]): RequiredField[] {
  return required.filter((f) => !HIDDEN_FIELDS.has(f.fieldname) && !LAYOUT_TYPES.has(f.fieldtype));
}

export function buildNewParty(doctype: PartyRef['doctype'], name: string, extra: Record<string, string>): NewParty {
  const n = name.trim();
  const fields: Record<string, unknown> = { [NAME_FIELD[doctype]]: n };
  for (const [k, v] of Object.entries(extra)) if (v.trim()) fields[k] = v.trim();
  return { ref: { doctype, name: n }, fields };
}

/** Client-side checks for the new-party form: field name -> message ('name' for the name). */
export function validateNewParty(name: string, extra: Record<string, string>, required: RequiredField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!name.trim()) errors.name = 'Enter a name.';
  for (const f of extraFields(required)) {
    const v = (extra[f.fieldname] ?? '').trim();
    if (!v) errors[f.fieldname] = `ERPNext needs ${f.label}.`;
    else if (f.fieldtype === 'Date' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors[f.fieldname] = 'Enter the date as YYYY-MM-DD, for example 1990-01-31.';
  }
  return errors;
}

const ref = (p: PartyRef): PartyRef => ({ doctype: p.doctype, name: p.name });

/** The planner's choice for these answers; throws PlanError('missing_choice') when one is missing. */
export function buildChoice(txn: PendingTxn, d: FlowDraft): ActionChoice {
  const missing = () => new PlanError('missing_choice');
  switch (d.action) {
    case 'customer_advance': case 'supplier_payment': case 'salary':
      if (!d.party) throw missing();
      return { type: d.action, party: ref(d.party) };
    case 'against_invoice':
      if (!d.party || !d.invoices?.length) throw missing();
      return { type: 'against_invoice', party: ref(d.party), invoices: d.invoices.map((i) => ({ ...i })) };
    case 'bill_paid_by_card':
      if (!d.party || d.invoices?.length !== 1) throw missing();
      return { type: 'bill_paid_by_card', party: ref(d.party), invoice: { name: d.invoices[0].name, allocatedMinor: d.invoices[0].allocatedMinor } };
    case 'expense':
      if (!d.account) throw missing();
      return d.party ? { type: 'expense', expenseAccount: d.account, party: ref(d.party) } : { type: 'expense', expenseAccount: d.account };
    case 'other_income':
      if (!d.account) throw missing();
      return { type: 'other_income', incomeAccount: d.account };
    case 'transfer':
      if (txn.direction === 'in') return { type: 'ignore' };
      if (!d.toAccount) throw missing();
      return { type: 'transfer', toAccount: d.toAccount };
    case 'personal': return { type: 'personal' };
    case 'ignore': return { type: 'ignore' };
    default: throw missing();
  }
}

export function buildContext(txn: PendingTxn, d: FlowDraft, s: FlowSettings): PlanContext {
  if (!d.mapping) throw new PlanError('missing_account');
  if (!s.company) throw new PlanError('missing_company');
  const ctx: PlanContext = { company: s.company, account: d.mapping, drawingsAccount: s.drawingsAccount, today: s.today };
  if (txn.currency !== 'INR' && d.inrAmountMinor !== undefined) ctx.inrAmountMinor = d.inrAmountMinor;
  if (d.newParty) ctx.newParty = { ref: ref(d.newParty.ref), fields: { ...d.newParty.fields } };
  return ctx;
}

/** The plan the confirm screen shows and the runner executes. Throws PlanError with a code for the UI. */
export function planFor(txn: PendingTxn, d: FlowDraft, s: FlowSettings): { plan: ActionPlan; choice: ActionChoice } {
  const ctx = buildContext(txn, d, s);
  const choice = buildChoice(txn, d);
  if (choice.type === 'ignore') {
    return { choice, plan: { steps: [], summary: [d.action === 'transfer' ? TRANSFER_IN_NOTE : IGNORE_NOTE], needsInrAmount: false } };
  }
  if (choice.type === 'personal' && !s.drawingsAccount) throw new PlanError('missing_drawings');
  const plan = planAction(txn, choice, ctx);
  // The runner refuses a plan that still needs the INR amount; the flow asks for it before confirm.
  if (plan.needsInrAmount) throw new PlanError('missing_amount');
  return { plan, choice };
}

// ---------- invoice allocation ----------

/** Default allocation: the invoice's outstanding, capped at what is left of the transaction amount. */
export function defaultAllocation(amountMinor: number, outstandingMinor: number, otherAllocations: number[]): number {
  const left = amountMinor - otherAllocations.reduce((a, b) => a + b, 0);
  return Math.max(0, Math.min(outstandingMinor, left));
}

export type AllocationCheck = { ok: boolean; totalMinor: number; errors: Record<string, string>; total?: string };

export function validateAllocations(amountMinor: number, rows: { name: string; outstandingMinor: number; allocatedMinor: number }[]): AllocationCheck {
  const errors: Record<string, string> = {};
  let totalMinor = 0;
  for (const r of rows) {
    totalMinor += r.allocatedMinor;
    if (!(r.allocatedMinor > 0)) errors[r.name] = 'Enter an amount above zero.';
    else if (r.allocatedMinor > r.outstandingMinor) errors[r.name] = `More than the ${formatInr(r.outstandingMinor)} still due on ${r.name}.`;
  }
  const out: AllocationCheck = { ok: true, totalMinor, errors };
  if (rows.length === 0) out.total = 'Choose at least one invoice.';
  else if (totalMinor > amountMinor) {
    out.total = `You allocated ${formatInr(totalMinor)}, more than the ${formatInr(amountMinor)} of this transaction. Lower an amount.`;
  }
  out.ok = !out.total && Object.keys(errors).length === 0;
  return out;
}
