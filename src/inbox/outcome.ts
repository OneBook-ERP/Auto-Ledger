// What the UI does with a planner error or a runner result. Pure.
import { PlanError } from '../core/plan';
import type { ActionPlan } from '../core/types';
import { encodeSegment } from '../erp/client';
import type { RunResult } from '../outbox/runner';

export const UNKNOWN_FAILURE =
  'Something went wrong. Your answer may not have been saved; check the Inbox and Activity before trying again.';
export const GONE_MESSAGE = 'This message is no longer in your Inbox.';
export const OFFLINE_MESSAGE = 'No connection. Your answer is saved and will be sent when you are back online.';

const PLAN_MESSAGES: Record<string, string> = {
  date_out_of_range: 'This transaction is dated outside the usual range. Check the date in ERPNext.',
  bad_direction: 'This answer does not fit the direction of the money. Go back and choose another answer.',
  over_allocated: 'The invoice amounts add up to more than this transaction. Go back and lower an amount.',
  mixed_invoices: 'Choose only sales invoices or only purchase invoices, not both. Go back and change the invoices.',
  no_invoices: 'Choose at least one invoice. Go back to the invoice list.',
  same_account: 'Money cannot move from an account to itself. Go back and choose your other account.',
  missing_account: 'Choose which of your accounts this message belongs to first. Go back to the transaction.',
  missing_choice: 'Some answers are missing. Go back and complete them.',
  missing_drawings: 'Set your Drawings account in Settings first (Run setup again).',
  missing_company: 'Choose your company in Settings first (Run setup again).',
  missing_amount: 'Enter the amount in rupees first. Go back to the amount step.',
  bad_amount: 'The amount is not valid. Go back and enter it again.',
  bad_date: 'The date in the bank message could not be read. Create this entry in ERPNext instead.',
};
const GENERIC = 'This answer could not be prepared. Go back and check it.';

export function planErrorMessage(e: unknown): string {
  if (e instanceof PlanError) return PLAN_MESSAGES[e.code] ?? GENERIC;
  return GENERIC;
}

export type Outcome =
  | { kind: 'created'; docs: { doctype: string; name: string }[] }
  | { kind: 'login' }
  | { kind: 'offline'; message: string }
  | { kind: 'error'; message: string; missingFields: string[]; doctype: string | null; closedPeriod: boolean }
  | { kind: 'busy' }
  /** The txn row disappeared (Undo, a site switch): nothing to show here any more. */
  | { kind: 'gone' };

/**
 * The runner's plain-language note on the txn, when it describes THIS failure (it writes one for a rejected
 * step, including notes on drafts it could not remove); else null. Not keyed on the note changing: a repeated
 * identical failure still gets it. A stale note from an earlier, different failure is not used.
 */
export function readableFailure(error: { message: string; missingFields?: string[]; closedPeriod?: boolean }, txnError: string | null): string | null {
  if (!txnError) return null;
  if (error.missingFields?.length) return txnError.includes(error.missingFields.join(', ')) ? txnError : null;
  if (error.closedPeriod) return txnError.includes('accounting period is closed') ? txnError : null;
  return txnError.includes(error.message) ? txnError : null;
}

/** The document type a failure is about: the step the runner's message names, else the plan's main document. */
export function failedDoctype(message: string, plan: ActionPlan): string | null {
  for (const s of plan.steps) {
    const what = s.kind === 'create_party' ? `the new ${s.doctype}` : `the ${s.doctype}`;
    if (message.includes(`Could not create ${what}.`)) return s.doctype;
  }
  return plan.steps.find((s) => s.kind === 'create_doc')?.doctype ?? null;
}

/** `readable` is the runner's plain-language note stored on the txn by this run (null when it wrote none). */
export function outcomeOf(r: RunResult, readable: string | null, plan: ActionPlan): Outcome {
  if (r.status === 'created') return { kind: 'created', docs: r.docs };
  if (r.status === 'needs_login') return { kind: 'login' };
  if (r.retryable) return { kind: 'offline', message: OFFLINE_MESSAGE };
  const e = r.error as { message: string; missingFields?: string[]; closedPeriod?: boolean };
  const message = readable ?? e.message;
  return { kind: 'error', message, missingFields: e.missingFields ?? [], doctype: failedDoctype(message, plan), closedPeriod: !!e.closedPeriod };
}

const slug = (doctype: string) => doctype.toLowerCase().replace(/ /g, '-');

/** Desk URL of a document: <site>/app/<doctype slug>/<name>. */
export const erpDocUrl = (site: string, doctype: string, name: string) => `${site}/app/${slug(doctype)}/${encodeSegment(name)}`;
/** Desk URL of a new, empty document of this type. */
export const erpNewDocUrl = (site: string, doctype: string) => `${site}/app/${slug(doctype)}/new`;
