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
  id: string; state: 'new'|'created'|'submitted'|'ignored'|'failed';
  createdDocs: { doctype: string; name: string; docstatus: number }[]; error: string | null;
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
  progress: { stepIndex: number; created: { doctype: string; name: string }[] };
  attempts: number; status: 'pending'|'done'|'failed';
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
