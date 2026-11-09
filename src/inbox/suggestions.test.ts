import { suggest } from '../core/suggest';
import type { Rule, Suggestion } from '../core/types';
import { chipFor, draftFromSuggestion, suggestionCard, usableSuggestions } from './suggestions';
import { txnFrom } from './testData';

const rule = (over: Partial<Rule>): Rule => ({ matchKey: '', action: 'expense', hits: 1, lastUsed: 0, ...over });

describe('chipFor (inbox row chip)', () => {
  it('a learned rule: "You did this before"', () => {
    const t = txnFrom('idfc-034'); // GOOGLESERVIS on the card
    const s = suggest(t, [rule({ matchKey: 'm:out:googleservis', account: 'Advertising - ZP' })], [], []);
    expect(chipFor(t, s)).toEqual({ text: 'You did this before: Advertising', tone: 'accent' });
  });
  it('a utr rule, an exact invoice and a name match: "Suggested"', () => {
    const credit = txnFrom('idfc-006');
    const utr: Suggestion = { choice: { type: 'customer_advance', party: { doctype: 'Customer', name: 'C' } }, reason: 'utr', confidence: 1 };
    expect(chipFor(credit, [utr])).toEqual({ text: 'Suggested: customer advance', tone: 'accent' });
    const inv = suggest(credit, [], [{ doctype: 'Sales Invoice', name: 'SINV-1', outstandingMinor: credit.amountMinor, dueDate: '' }], []);
    expect(chipFor(credit, inv).text).toBe('Suggested: payment against an invoice');
    const name = suggest(credit, [], [], [{ doctype: 'Customer', name: 'COMPANY_11' }]);
    expect(name[0].reason).toBe('name_match');
    expect(chipFor(credit, name).text).toBe('Suggested: customer advance');
  });
  it('nothing known: "Who is this?"', () => {
    expect(chipFor(txnFrom('idfc-001'), [])).toEqual({ text: 'Who is this?', tone: 'plain' });
  });
  it('foreign currency always asks for the rupee amount first', () => {
    const t = txnFrom('idfc-040');
    const s = suggest(t, [rule({ matchKey: 'm:out:anthropicclaudesub', account: 'Software - ZP' })], [], []);
    expect(chipFor(t, s)).toEqual({ text: 'Enter the rupee amount', tone: 'warn' });
  });
  it('describes each action type briefly', () => {
    const t = txnFrom('idfc-010');
    const mk = (choice: Suggestion['choice']): Suggestion[] => [{ choice, reason: 'rule', confidence: 0.9 }];
    expect(chipFor(t, mk({ type: 'supplier_payment', party: { doctype: 'Supplier', name: 'S' } })).text).toBe('You did this before: supplier payment');
    expect(chipFor(t, mk({ type: 'salary', party: { doctype: 'Employee', name: 'E' } })).text).toBe('You did this before: salary');
    expect(chipFor(t, mk({ type: 'personal' })).text).toBe('You did this before: personal');
    expect(chipFor(t, mk({ type: 'ignore' })).text).toBe('You did this before: ignore');
  });
});

describe('usableSuggestions', () => {
  it('drops suggestions whose action the account cannot take', () => {
    const t = txnFrom('idfc-034'); // card debit
    const s: Suggestion[] = [
      { choice: { type: 'supplier_payment', party: { doctype: 'Supplier', name: 'Google' } }, reason: 'name_match', confidence: 0.6 },
      { choice: { type: 'expense', expenseAccount: 'Ads - ZP' }, reason: 'rule', confidence: 0.8 },
    ];
    expect(usableSuggestions(t, s, { drawings: true }).map((x) => x.choice.type)).toEqual(['expense']);
  });
  it('drops personal without a drawings account', () => {
    const t = txnFrom('idfc-010');
    const s: Suggestion[] = [{ choice: { type: 'personal' }, reason: 'rule', confidence: 0.8 }];
    expect(usableSuggestions(t, s, { drawings: false })).toEqual([]);
    expect(usableSuggestions(t, s, { drawings: true })).toHaveLength(1);
  });
});

describe('suggestion card and draft', () => {
  const credit = txnFrom('idfc-006');
  it('card text for a name match', () => {
    const s: Suggestion = { choice: { type: 'customer_advance', party: { doctype: 'Customer', name: 'Acme Test Traders' } }, reason: 'name_match', confidence: 0.7 };
    expect(suggestionCard(s)).toEqual({ title: 'Advance from Acme Test Traders', subtitle: 'Matched by name. Creates a draft payment entry.' });
  });
  it('card text for a learned expense rule', () => {
    const s: Suggestion = { choice: { type: 'expense', expenseAccount: 'Advertising - ZP' }, reason: 'rule', confidence: 0.82 };
    expect(suggestionCard(s)).toEqual({ title: 'Expense: Advertising', subtitle: 'You did this before. Creates a draft journal entry.' });
  });
  it('card text for ignore', () => {
    const s: Suggestion = { choice: { type: 'ignore' }, reason: 'rule', confidence: 0.82 };
    expect(suggestionCard(s).subtitle).toBe('You did this before. Nothing is added to ERPNext.');
  });
  it('draftFromSuggestion carries the party, account and invoices', () => {
    expect(draftFromSuggestion({ choice: { type: 'expense', expenseAccount: 'Ads - ZP' }, reason: 'rule', confidence: 1 })).toEqual({ action: 'expense', account: 'Ads - ZP' });
    expect(draftFromSuggestion({ choice: { type: 'other_income', incomeAccount: 'Interest - ZP' }, reason: 'rule', confidence: 1 })).toEqual({ action: 'other_income', account: 'Interest - ZP' });
    const p = { doctype: 'Customer' as const, name: 'Acme' };
    expect(draftFromSuggestion({ choice: { type: 'customer_advance', party: p }, reason: 'rule', confidence: 1 })).toEqual({ action: 'customer_advance', party: p });
    const inv = { type: 'against_invoice' as const, invoices: [{ doctype: 'Sales Invoice' as const, name: 'S1', allocatedMinor: credit.amountMinor }] };
    expect(draftFromSuggestion({ choice: inv, reason: 'exact_invoice_amount', confidence: 0.75 }, p)).toEqual({ action: 'against_invoice', party: p, invoices: inv.invoices });
  });
});
