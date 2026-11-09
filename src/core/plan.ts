import type { AccountMapping, ActionChoice, ActionPlan, ParsedTxn, PartyRef, PendingTxn, PlanStep } from './types';

export type { ActionChoice, ActionPlan, PlanStep } from './types';

export interface PlanContext {
  company: string;
  account: AccountMapping;
  drawingsAccount: string;
  inrAmountMinor?: number;
  /** YYYY-MM-DD, injected so tests are deterministic. */
  today: string;
  newParty?: { ref: PartyRef; fields: Record<string, unknown> };
  /**
   * Reference written instead of txnReference(txn) (R54): the second leg of an own-account transfer uses the
   * first leg's reference, so the runner finds and adopts that leg's Payment Entry instead of booking it twice.
   */
  referenceOverride?: string;
}

export class PlanError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'PlanError';
    this.code = code;
  }
}

/** Reference written to Payment Entry `reference_no` / Journal Entry `cheque_no`. */
export function txnReference(txn: ParsedTxn): string {
  return txn.utr ?? 'AL-' + txn.rawHash;
}

function majorString(minor: number): string {
  if (!Number.isInteger(minor) || minor < 0) throw new PlanError('bad_amount', `bad amount ${minor}`);
  const whole = Math.floor(minor / 100);
  const frac = String(minor % 100).padStart(2, '0');
  return `${whole}.${frac}`;
}

/** Integer minor units to a major-unit number, with no floating-point arithmetic. */
export function minorToMajor(minor: number): number {
  return Number(majorString(minor));
}

function group(whole: string, indian: boolean): string {
  if (!indian) return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (whole.length <= 3) return whole;
  return whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + whole.slice(-3);
}
function formatMoney(minor: number, indian: boolean): string {
  const [w, f] = majorString(minor).split('.');
  return `${group(w, indian)}.${f}`;
}
const rupees = (minor: number) => '₹' + formatMoney(minor, true);

const DAY = 86_400_000;
function dayNumber(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new PlanError('bad_date', `bad date ${iso}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new PlanError('bad_date', `bad date ${iso}`);
  }
  return Math.round(dt.getTime() / DAY);
}

const sameParty = (a: PartyRef, b: PartyRef) => a.doctype === b.doctype && a.name === b.name;

export function planAction(txn: PendingTxn, choice: ActionChoice, ctx: PlanContext): ActionPlan {
  if (choice.type === 'ignore') return { steps: [], summary: [], needsInrAmount: false };

  const age = dayNumber(ctx.today) - dayNumber(txn.occurredOn);
  if (age < -1 || age > 400) {
    throw new PlanError('date_out_of_range', `Transaction date ${txn.occurredOn} is outside the allowed range`);
  }

  const dir = txn.direction;
  const need = (d: 'in' | 'out') => {
    if (dir !== d) throw new PlanError('bad_direction', `${choice.type} needs a money-${d} transaction`);
  };

  const foreign = txn.currency !== 'INR';
  if (foreign && ctx.inrAmountMinor === undefined) {
    return {
      steps: [],
      summary: [`Enter the INR amount for this ${txn.currency} ${formatMoney(txn.amountMinor, false)} transaction`],
      needsInrAmount: true,
    };
  }
  const minor = foreign ? (ctx.inrAmountMinor as number) : txn.amountMinor;
  const amount = minorToMajor(minor);
  const ref = ctx.referenceOverride?.trim() ? ctx.referenceOverride : txnReference(txn);
  const date = txn.occurredOn;
  const who = txn.counterparty ?? txn.merchant;
  const remarkParts = ['AutoLedger'];
  if (who) remarkParts.push(who);
  if (foreign) remarkParts.push(`${txn.currency} ${formatMoney(txn.amountMinor, false)} (INR value entered by user)`);
  const remarks = remarkParts.join(' | ');
  const tail = `UTR/ref ${ref}, ${date}`;

  const doc = (doctype: string, body: Record<string, unknown>): PlanStep => ({ kind: 'create_doc', doctype, body });
  const pe = (extra: Record<string, unknown>): PlanStep =>
    doc('Payment Entry', {
      company: ctx.company, posting_date: date, mode_of_payment: ctx.account.modeOfPayment,
      paid_amount: amount, received_amount: amount, reference_no: ref, reference_date: date, remarks, ...extra,
    });
  const je = (debit: { account: string; extra?: object }, credit: { account: string }): PlanStep =>
    doc('Journal Entry', {
      company: ctx.company, posting_date: date, voucher_type: 'Journal Entry', cheque_no: ref, cheque_date: date, user_remark: remarks,
      accounts: [
        { account: debit.account, ...debit.extra, debit_in_account_currency: amount },
        { account: credit.account, credit_in_account_currency: amount },
      ],
    });

  const gl = ctx.account.glAccount;
  const amt = rupees(minor);
  let step: PlanStep;
  let line: string;
  let party: PartyRef | undefined;

  switch (choice.type) {
    case 'customer_advance':
      need('in');
      party = choice.party;
      step = pe({ payment_type: 'Receive', party_type: 'Customer', party: party.name, paid_to: gl });
      line = `Payment Entry (draft): receive ${amt} from ${party.name} as advance, ${tail}`;
      break;
    case 'supplier_payment':
      need('out');
      party = choice.party;
      step = pe({ payment_type: 'Pay', party_type: 'Supplier', party: party.name, paid_from: gl });
      line = `Payment Entry (draft): pay ${amt} to ${party.name} (supplier), ${tail}`;
      break;
    case 'against_invoice': {
      if (choice.invoices.length === 0) throw new PlanError('no_invoices');
      const dt = choice.invoices[0].doctype;
      if (choice.invoices.some((i) => i.doctype !== dt)) throw new PlanError('mixed_invoices');
      const receive = dt === 'Sales Invoice';
      need(receive ? 'in' : 'out');
      const total = choice.invoices.reduce((s, i) => s + i.allocatedMinor, 0);
      if (total > minor) throw new PlanError('over_allocated', 'Allocated more than the transaction amount');
      party = choice.party;
      const references = choice.invoices.map((i) => ({
        reference_doctype: i.doctype, reference_name: i.name, allocated_amount: minorToMajor(i.allocatedMinor),
      }));
      step = pe(receive
        ? { payment_type: 'Receive', party_type: 'Customer', party: party.name, paid_to: gl, references }
        : { payment_type: 'Pay', party_type: 'Supplier', party: party.name, paid_from: gl, references });
      const names = choice.invoices.map((i) => `${i.name} (${rupees(i.allocatedMinor)})`).join(', ');
      line = `Payment Entry (draft): ${receive ? 'receive' : 'pay'} ${amt} ${receive ? 'from' : 'to'} ${party.name} against ${names}, ${tail}`;
      break;
    }
    case 'bill_paid_by_card':
      need('out');
      if (choice.invoice.allocatedMinor > minor) throw new PlanError('over_allocated', 'Allocated more than the transaction amount');
      party = choice.party;
      step = pe({
        payment_type: 'Pay', party_type: 'Supplier', party: party.name, paid_from: gl,
        references: [{ reference_doctype: 'Purchase Invoice', reference_name: choice.invoice.name, allocated_amount: minorToMajor(choice.invoice.allocatedMinor) }],
      });
      line = `Payment Entry (draft): pay ${amt} to ${party.name} by card against ${choice.invoice.name}, ${tail}`;
      break;
    case 'expense':
      need('out');
      party = choice.party;
      step = je(
        { account: choice.expenseAccount, extra: party ? { party_type: party.doctype, party: party.name } : undefined },
        { account: gl },
      );
      line = `Journal Entry (draft): expense ${amt} to ${choice.expenseAccount}${party ? ` for ${party.name}` : ''}, paid from ${gl}, ${tail}`;
      break;
    case 'salary':
      need('out');
      party = choice.party;
      step = pe({ payment_type: 'Pay', party_type: 'Employee', party: party.name, paid_from: gl });
      line = `Payment Entry (draft): pay ${amt} to ${party.name} (employee), ${tail}`;
      break;
    case 'other_income':
      need('in');
      step = je({ account: gl }, { account: choice.incomeAccount });
      line = `Journal Entry (draft): other income ${amt} into ${gl}, credited to ${choice.incomeAccount}, ${tail}`;
      break;
    case 'transfer':
      if ('fromAccount' in choice) {
        // Money in from another own account (R52b): paid_from is the source, paid_to this account.
        need('in');
        const from = choice.fromAccount;
        if (from.glAccount === gl) throw new PlanError('same_account', 'Cannot transfer from the same account');
        step = pe({ payment_type: 'Internal Transfer', paid_from: from.glAccount, paid_to: gl, mode_of_payment: from.modeOfPayment ?? ctx.account.modeOfPayment });
        line = `Internal transfer: ${amt} from ${from.glAccount} into ${gl}, ${tail}`;
      } else {
        need('out');
        if (choice.toAccount.glAccount === gl) throw new PlanError('same_account', 'Cannot transfer to the same account');
        step = pe({ payment_type: 'Internal Transfer', paid_from: gl, paid_to: choice.toAccount.glAccount });
        line = `Internal transfer: ${amt} from ${gl} into ${choice.toAccount.glAccount}, ${tail}`;
      }
      break;
    case 'personal':
      step = dir === 'out' ? je({ account: ctx.drawingsAccount }, { account: gl }) : je({ account: gl }, { account: ctx.drawingsAccount });
      line = `Journal Entry (draft): personal ${dir === 'out' ? 'withdrawal' : 'deposit'} ${amt} ${dir === 'out' ? 'from' : 'into'} ${gl}, booked to ${ctx.drawingsAccount}, ${tail}`;
      break;
  }

  const steps: PlanStep[] = [];
  const summary: string[] = [];
  if (ctx.newParty && party && sameParty(ctx.newParty.ref, party)) {
    steps.push({ kind: 'create_party', doctype: party.doctype, body: ctx.newParty.fields });
    summary.push(`New ${party.doctype} will be created: ${party.name}`);
  }
  steps.push(step);
  summary.push(line);
  return { steps, summary, needsInrAmount: false };
}
