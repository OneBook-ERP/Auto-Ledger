// Shared types. Types only, no logic (later tasks add logic).

export type TxnKind = 'ca_credit'|'ca_debit'|'neft_confirm'|'card_spend'|'card_si_paid';
export interface ParsedTxn {
  kind: TxnKind; direction: 'in'|'out'; amountMinor: number; currency: string;
  occurredOn: string;            // YYYY-MM-DD, from the SMS body
  occurredTime: string | null;   // HH:mm 24h, IST, or null
  accountType: 'bank'|'card'; accountLast4: string | null;
  counterparty: string | null; utr: string | null; merchant: string | null;
  balanceMinor: number | null; sender: string; receivedAt: number; rawHash: string;
}
export type IgnoreReason = 'otp'|'si_notice'|'not_money'|'unknown_template';
export type ParseResult = { ok: true; txn: ParsedTxn } | { ok: false; reason: IgnoreReason };
export interface PendingTxn extends ParsedTxn {
  id: string; mergedCount: number; // 1 for a fresh item; see Correlation
  state: 'new'|'created'|'submitted'|'ignored'|'failed';
  createdDocs: { doctype: string; name: string; docstatus: number; adopted?: boolean }[]; error: string | null;
}

export type PartyRef = { doctype: 'Customer'|'Supplier'|'Employee'; name: string };

export type AccountMapping = {
  bankAccount: string; glAccount: string; kind: 'bank'|'card';
  senderIds: string[]; last4: string[]; modeOfPayment: string;
};

export type ActionChoice =
 | {type:'customer_advance'; party: PartyRef}
 | {type:'supplier_payment'; party: PartyRef}
 | {type:'against_invoice'; party: PartyRef; invoices: {doctype:'Sales Invoice'|'Purchase Invoice'; name: string; allocatedMinor: number}[]}
 | {type:'bill_paid_by_card'; party: PartyRef; invoice: {name: string; allocatedMinor: number}}
 | {type:'expense'; expenseAccount: string; party?: PartyRef}
 | {type:'salary'; party: PartyRef}
 | {type:'other_income'; incomeAccount: string}
 | {type:'transfer'; toAccount: AccountMapping}
 | {type:'personal'} | {type:'ignore'};

export interface PlanStep { kind: 'create_party'|'create_doc'; doctype: string; body: Record<string, unknown> }
export interface ActionPlan { steps: PlanStep[]; summary: string[]; needsInrAmount: boolean }

export type Rule = {
  matchKey: string; action: ActionChoice['type']; party?: PartyRef; account?: string;
  hits: number; lastUsed: number;
};

export type OpenInvoice = { doctype: string; name: string; outstandingMinor: number; dueDate: string };

export type Suggestion = {
  choice: Partial<ActionChoice>;
  reason: 'rule'|'utr'|'exact_invoice_amount'|'name_match';
  confidence: number;
};

export type OutboxOp = {
  id: string; txnId: string; plan: ActionPlan;
  // `attempting`: index of a step whose server write (createParty/createDraft) was started but not yet
  // recorded as done (write-ahead marker; a lost reply leaves it set). `adopted` on a created entry: the step
  // reused a document found by reference that this app did not create (never deleted by cleanup).
  progress: { stepIndex: number; created: { doctype: string; name: string; adopted?: boolean }[]; attempting?: number };
  attempts: number; status: 'pending'|'done'|'failed'|'superseded';
};

export type TemplateSet = {
  version: number;
  otpPattern: string;
  moneyVerbPattern: string;
  amountPattern: string;
  notes?: string[];
  banks: {
    id: string;
    senderPattern: string;
    templates: {
      id: string;
      kind: TxnKind | 'ignore';
      direction?: 'in'|'out';
      ignoreReason?: IgnoreReason;
      accountType: 'bank'|'card';
      regex: string;
    }[];
  }[];
};

// The pipeline (Task 15) must increment the target's `mergedCount` on every
// `enrich` and on every `drop_duplicate` whose reason is 'paired' or
// 'empty_patch' ('same_sms' does not count). `correlate` only pairs a
// complementary SMS with an item whose mergedCount is 1.
export type Correlation =
 | { action: 'insert' }
 | { action: 'drop_duplicate'; of: string; reason: 'same_sms'|'paired'|'empty_patch' }
 | { action: 'enrich'; target: string; patch: Partial<ParsedTxn> };
