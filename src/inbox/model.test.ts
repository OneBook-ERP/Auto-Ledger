import type { PendingTxn, Rule } from '../core/types';
import { suggest } from '../core/suggest';
import {
  amountRange, answerText, automaticRule, buildInboxModel, bulkActions, bulkSummary, bulkTitle, createChipCache, kindIconOf, pageItems, planChoice, plainFailure,
  type InboxInputs,
} from './model';
import { BANK, CARD, NOW, txnFrom } from './testData';

const base = (over: Partial<InboxInputs> = {}): InboxInputs => ({
  pending: [], mappings: [BANK, CARD], rules: [], createdCount: 0, unreadCount: 0, unknownAccounts: [],
  lastSyncedAt: null, now: NOW, queuedIds: [], ...over,
});

jest.mock('../core/suggest', () => {
  const actual = jest.requireActual('../core/suggest');
  return { ...actual, suggest: jest.fn(actual.suggest) };
});

describe('buildInboxModel', () => {
  it('filter: count, sections and suggestions follow the matching rows; no match differs from empty', () => {
    const a = txnFrom('idfc-006', { id: 'a', counterparty: 'Fuel Station', occurredOn: '2026-11-08' });
    const b = txnFrom('idfc-010', { id: 'b', counterparty: 'Old Shop', occurredOn: '2026-09-01' });
    const m = buildInboxModel(base({ pending: [a, b], filter: { query: 'fuel', period: 'all' } }));
    expect(m.rows.map((r) => r.id)).toEqual(['a']);
    expect(m.countLabel).toBe('1 to answer');
    expect(m.sections.map((s) => s.title)).toEqual(['Today']);
    expect(m.empty).toBe(false);
    expect(m.noMatch).toBe(false);
    const none = buildInboxModel(base({ pending: [a, b], filter: { query: 'zzz', period: 'all' } }));
    expect(none).toMatchObject({ empty: false, noMatch: true, countLabel: 'Nothing to answer' });
    expect(buildInboxModel(base()).noMatch).toBe(false);
  });
  it('empty inbox', () => {
    const m = buildInboxModel(base());
    expect(m.empty).toBe(true);
    expect(m.countLabel).toBe('Nothing to answer');
    expect(m.trustLine).toBe('Not synced yet · 0 drafts waiting for your accountant');
  });
  it('rows newest first with title, subtitle, signed amount and chip', () => {
    const a = txnFrom('idfc-006'); // 2026-11-05 credit COMPANY_11
    const b = txnFrom('idfc-034'); // 2026-11-04 card GOOGLESERVIS
    const c = txnFrom('idfc-040'); // 2026-11-08 USD
    const rules: Rule[] = [{ matchKey: 'm:out:googleservis', action: 'expense', account: 'Advertising - ZP', hits: 2, lastUsed: 1 }];
    const m = buildInboxModel(base({ pending: [b, a, c], rules, createdCount: 3, lastSyncedAt: NOW - 120_000 }));
    expect(m.rows.map((r) => r.id)).toEqual([c.id, a.id, b.id]);
    expect(m.countLabel).toBe('3 to answer');
    expect(m.trustLine).toBe('Synced 2 min ago · 3 drafts waiting for your accountant');
    const [rc, ra, rb] = m.rows;
    expect(ra).toMatchObject({ title: 'COMPANY_11', amountText: '+₹30,000.00', amountA11y: '₹30,000.00 received', direction: 'in' });
    expect(m.chipOf(ra.id)).toEqual({ text: 'Who is this?', tone: 'plain' });
    expect(ra.subtitle).toBe('Credit · IDFC First …6507 · 5 Nov'); // the long-format credit has no time
    expect(m.chipOf(rb.id)).toEqual({ text: 'You did this before: Advertising', tone: 'accent' });
    expect(rb.subtitle.startsWith('Card spend · IDFC Credit Card …3455 · ')).toBe(true);
    expect(m.chipOf(rc.id)).toEqual({ text: 'Enter the rupee amount', tone: 'warn' });
    expect(rc.amountText).toBe('−USD 100.00');
    expect(m.sections.map((s) => [s.title, s.rows.length])).toEqual([['Today', 1], ['Earlier', 2]]);
  });
  it('groups every row of a day together, newest first inside the group, whatever the received order', () => {
    const todayOld = txnFrom('idfc-006', { id: 'a', occurredOn: '2026-11-08', receivedAt: 1 });
    const earlierNew = txnFrom('idfc-010', { id: 'b', occurredOn: '2026-11-01', receivedAt: 3 });
    const todayNew = txnFrom('idfc-011', { id: 'c', occurredOn: '2026-11-08', receivedAt: 2 });
    const yest = txnFrom('idfc-012', { id: 'd', occurredOn: '2026-11-07', receivedAt: 4 });
    const m = buildInboxModel(base({ pending: [todayOld, earlierNew, todayNew, yest] }));
    expect(m.sections.map((s) => [s.title, s.rows.map((r) => r.id)])).toEqual([['Today', ['c', 'a']], ['Yesterday', ['d']], ['Earlier', ['b']]]);
    expect(m.rows.map((r) => r.id)).toEqual(['c', 'a', 'd', 'b']);
    expect(new Set(m.sections.map((s) => s.title)).size).toBe(m.sections.length);
  });
  it('one draft: singular', () => {
    expect(buildInboxModel(base({ createdCount: 1, lastSyncedAt: NOW })).trustLine).toBe('Synced just now · 1 draft waiting for your accountant');
  });
  it('account not set when the mapping cannot be resolved', () => {
    const t = txnFrom('idfc-016'); // no last 4
    const two = { ...BANK, bankAccount: 'Other - ZP', glAccount: 'Other - ZP', last4: ['9999'] };
    expect(buildInboxModel(base({ pending: [t], mappings: [BANK, two] })).rows[0].subtitle).toContain('Account not set');
  });
  it('queued answers show as waiting to send', () => {
    const t = txnFrom('idfc-006');
    expect(buildInboxModel(base({ pending: [t], queuedIds: [t.id] })).chipOf(t.id)).toEqual({ text: 'Answer saved, waiting to send', tone: 'plain' });
  });
  it('banners: unreadable messages and unknown accounts', () => {
    const m = buildInboxModel(base({ unreadCount: 2, unknownAccounts: ['4321'] }));
    expect(m.unreadText).toBe('2 messages could not be read');
    expect(m.unknownAccounts).toEqual([{ last4: '4321', text: 'Unrecognised account ending 4321: add it in Settings' }]);
    expect(m.accountsNotice).toEqual({ last4s: ['4321'], text: '1 account is not set up: 4321' });
    expect(buildInboxModel(base({ unknownAccounts: ['3455', '6507'] })).accountsNotice?.text).toBe('2 accounts are not set up: 3455, 6507');
    expect(buildInboxModel(base()).accountsNotice).toBeNull();
    expect(buildInboxModel(base({ unreadCount: 1 })).unreadText).toBe('1 message could not be read');
    expect(buildInboxModel(base()).unreadText).toBeNull();
  });
  it('merchant rows ask "What was this?", people keep "Who is this?"', () => {
    const card = txnFrom('idfc-034', { id: 'm' }); // card spend, merchant only
    expect(card.merchant).toBeTruthy();
    expect(card.counterparty).toBeNull();
    const m = buildInboxModel(base({ pending: [card, txnFrom('idfc-006', { id: 'p' })] }));
    expect(m.chipOf('m').text).toBe('What was this?');
    expect(m.chipOf('p').text).toBe('Who is this?');
  });
  it('leading icon by kind', () => {
    expect(kindIconOf({ kind: 'card_spend', counterparty: null })).toBe('card');
    expect(kindIconOf({ kind: 'card_si_paid', counterparty: null })).toBe('card');
    expect(kindIconOf({ kind: 'neft_confirm', counterparty: 'ACME' })).toBe('bank');
    expect(kindIconOf({ kind: 'ca_debit', counterparty: 'ravi@okbank' })).toBe('upi');
  });
});

describe('fast model (Task I3)', () => {
  const many = (n: number): PendingTxn[] =>
    Array.from({ length: n }, (_, k) => txnFrom('idfc-006', { id: `t${k}`, rawHash: `h${k}`, receivedAt: 1000 + k, occurredOn: k % 3 === 0 ? '2026-11-08' : k % 3 === 1 ? '2026-11-07' : '2026-10-01' }));

  it('builds 3,000 rows in well under 300 ms and computes no suggestion', () => {
    const pending = many(3000);
    (suggest as jest.Mock).mockClear();
    const t0 = Date.now();
    const m = buildInboxModel(base({ pending }));
    expect(Date.now() - t0).toBeLessThan(300);
    expect(m.rows).toHaveLength(3000);
    expect(suggest).not.toHaveBeenCalled();
  });

  it('suggestions run on demand and are remembered across rebuilds (answering one item does not redo the others)', () => {
    const pending = many(40);
    const chips = createChipCache();
    (suggest as jest.Mock).mockClear();
    const m1 = buildInboxModel(base({ pending, chips }));
    for (const r of m1.rows.slice(0, 10)) m1.chipOf(r.id);
    expect(suggest).toHaveBeenCalledTimes(10);
    const m2 = buildInboxModel(base({ pending: pending.filter((t) => t.id !== 't39'), chips }));
    for (const r of m2.rows.slice(0, 10)) m2.chipOf(r.id);
    // only the one row that newly scrolled into the first ten is computed
    expect(suggest).toHaveBeenCalledTimes(11);
  });

  it('a changed rule recomputes the chip', () => {
    const pending = [txnFrom('idfc-034', { id: 'g' })];
    const chips = createChipCache();
    const m1 = buildInboxModel(base({ pending, chips }));
    expect(m1.chipOf('g').text).not.toBe('You did this before: Advertising');
    const rules: Rule[] = [{ matchKey: 'm:out:googleservis', action: 'expense', account: 'Advertising - ZP', hits: 2, lastUsed: 1 }];
    expect(buildInboxModel(base({ pending, chips, rules })).chipOf('g').text).toBe('You did this before: Advertising');
  });

  it('pageItems takes the first rows with their headings and stops at the limit', () => {
    const m = buildInboxModel(base({ pending: many(9) })); // 3 Today, 3 Yesterday, 3 Earlier
    expect(pageItems(m.sections, 4).map((x) => (x.type === 'header' ? x.title : x.row.id))).toEqual(
      ['Today', 't6', 't3', 't0', 'Yesterday', 't7']);
    expect(pageItems(m.sections, 100).filter((x) => x.type === 'row')).toHaveLength(9);
  });
});

describe('group cards (wave 3 K3)', () => {
  const fb = (id: string, amountMinor: number, over: Partial<PendingTxn> = {}) =>
    txnFrom('idfc-035', { id, rawHash: `h-${id}`, amountMinor, receivedAt: 1000 + amountMinor, ...over });

  it('one card per pattern of 2 or more, with the count, the name and the rupee total', () => {
    const items = [fb('a', 100_000), fb('b', 2_400_000), fb('c', 10_000_000), txnFrom('idfc-034')];
    const m = buildInboxModel(base({ pending: items }));
    expect(m.groups).toEqual([
      expect.objectContaining({ key: 'm:out:facebooksi', count: 3, title: '3 payments to FACEBOOK SI, ₹1,25,000.00 in total', answer: 'Choose what these were' }),
    ]);
  });

  it('shows the remembered answer when a rule exists for exactly this pattern', () => {
    const rules: Rule[] = [{ matchKey: 'm:out:facebooksi', action: 'expense', account: 'Advertising - ZP', hits: 2, lastUsed: 1 }];
    const m = buildInboxModel(base({ pending: [fb('a', 100), fb('b', 200)], rules }));
    expect(m.groups[0].answer).toBe('Suggested: Expense, Advertising');
  });

  it('an answer that cannot be given in bulk is not suggested on the card', () => {
    const rules: Rule[] = [{ matchKey: 'm:out:facebooksi', action: 'bill_paid_by_card', party: { doctype: 'Supplier', name: 'Meta' }, hits: 2, lastUsed: 1 }];
    const m = buildInboxModel(base({ pending: [fb('a', 100), fb('b', 200)], rules }));
    expect(m.groups[0].answer).toBe('Choose what these were');
  });

  it('follows the search and filters, and leaves out answers waiting to be sent', () => {
    const items = [fb('a', 100), fb('b', 200), fb('c', 300, { occurredOn: '2025-01-01' })];
    expect(buildInboxModel(base({ pending: items, filter: { query: '', period: 'this_month' } })).groups[0].count).toBe(2);
    expect(buildInboxModel(base({ pending: items, queuedIds: ['a'], filter: { query: '', period: 'this_month' } })).groups).toEqual([]);
    expect(buildInboxModel(base({ pending: items, filter: { query: 'zzz', period: 'all' } })).groups).toEqual([]);
  });

  it('money in reads "from"; mixed currencies show no total', () => {
    const a = txnFrom('idfc-006', { id: 'a', rawHash: 'ha' });
    const b = txnFrom('idfc-006', { id: 'b', rawHash: 'hb', amountMinor: 50 });
    expect(buildInboxModel(base({ pending: [a, b] })).groups[0].title).toBe('2 payments from COMPANY_11, ₹30,000.50 in total');
    const usd = fb('u', 100, { currency: 'USD' });
    expect(buildInboxModel(base({ pending: [fb('x', 100), usd] })).groups[0].title).toBe('2 payments to FACEBOOK SI');
  });

  it('banner text for payments done automatically since the last dismiss', () => {
    expect(buildInboxModel(base()).autoDoneText).toBeNull();
    expect(buildInboxModel(base({ autoDoneCount: 1 })).autoDoneText).toBe('1 payment was done automatically. See Activity.');
    expect(buildInboxModel(base({ autoDoneCount: 3 })).autoDoneText).toBe('3 payments were done automatically. See Activity.');
  });

  it('a row whose automatic answer failed says so in its chip', () => {
    const a = fb('a', 100);
    const m = buildInboxModel(base({ pending: [a], autoFailed: { a: 'ERPNext needs these fields: Cost Center' } }));
    expect(m.chipOf('a')).toEqual({ text: 'Not done automatically. Open it to answer.', tone: 'warn' });
    expect(m.autoFailed).toEqual([{ id: 'a', text: 'FACEBOOK SI, ₹1.00: ERPNext needs these fields: Cost Center' }]);
  });
});

describe('bulk helpers (wave 3 K3)', () => {
  const fb = (id: string, amountMinor: number, over: Partial<PendingTxn> = {}) => txnFrom('idfc-035', { id, rawHash: `h-${id}`, amountMinor, ...over });

  it('amountRange: lowest to highest rupee amount', () => {
    expect(amountRange([fb('a', 50_000), fb('b', 1_200_000), fb('c', 2_000)])).toBe('₹20.00 to ₹12,000.00');
    expect(amountRange([fb('a', 50_000)])).toBe('₹500.00');
    expect(amountRange([fb('a', 50_000, { currency: 'USD' })])).toBeNull();
    expect(amountRange([])).toBeNull();
  });

  it('bulkSummary maps the result honestly', () => {
    expect(bulkSummary({ done: ['a', 'b', 'c'], failed: [], queued: [], skipped: [] })).toBe('3 done');
    expect(bulkSummary({ done: ['a'], failed: [{ id: 'x', message: 'm' }], queued: ['q', 'r'], skipped: [] }))
      .toBe('1 done, 2 saved to send later, 1 needs your attention');
    expect(bulkTitle({ done: ['a'], failed: [{ id: 'x', message: 'm' }], queued: [], skipped: [] })).toBe('Done');
    expect(bulkTitle({ done: [], failed: [{ id: 'x', message: 'm' }], queued: ['q'], skipped: [] })).toBe('Needs your attention');
    expect(bulkTitle({ done: [], failed: [], queued: ['q'], skipped: [] })).toBe('Saved to send later');
    expect(bulkTitle({ done: [], failed: [], queued: [], skipped: ['s'] })).toBe('Already answered');
    expect(bulkSummary({ done: [], failed: [{ id: 'x', message: 'm' }, { id: 'y', message: 'm' }], queued: [], skipped: ['s'] }))
      .toBe('0 done, 2 need your attention, 1 was already answered');
  });

  it('plainFailure never shows a document id or a document type name', () => {
    expect(plainFailure('An entry ACC-PAY-2026-00012 (Payment Entry) already exists for this reference. Open it in ERPNext and check it, or ask your accountant.'))
      .toBe('An entry already exists for this reference. Open it in ERPNext and check it, or ask your accountant.');
    expect(plainFailure('ACC-JV-2026-00001 was already submitted in ERPNext; cancel it there first.'))
      .toBe('An entry was already submitted in ERPNext; cancel it there first.');
    expect(plainFailure('ERPNext needs these fields: Cost Center')).toBe('ERPNext needs these fields: Cost Center');
    expect(plainFailure('Removed PE-9, JE-3 from ERPNext.')).toBe('Removed from ERPNext.');
    expect(plainFailure('Could not create the Journal Entry. An entry JE-4 already exists.')).toBe('Could not create the entry. An entry already exists.');
    expect(plainFailure('It could not be processed (ACC-JV-2026-00001); try again.')).toBe('It could not be processed; try again.');
    expect(plainFailure('An entry JV/25-26/0001 already exists.')).toBe('An entry already exists.');
    expect(plainFailure('PINV/0042 was already submitted in ERPNext.')).toBe('An entry was already submitted in ERPNext.');
    expect(plainFailure('Could not create the Purchase Invoice for a Sales Invoice.')).toBe('Could not create the bill for an invoice.');
  });

  it('bulkActions: only the five bulk answers that fit every item', () => {
    const card = [fb('a', 1), fb('b', 2)];
    expect(bulkActions(card).map((a) => a.type)).toEqual(['expense', 'personal', 'ignore']);
    const bank = [txnFrom('idfc-010', { id: 'x' })];
    expect(bulkActions(bank).map((a) => a.type)).toEqual(['supplier_payment', 'expense', 'personal', 'ignore']);
    expect(bulkActions([...card, ...bank]).map((a) => a.type)).toEqual(['expense', 'personal', 'ignore']);
  });

  it('answerText names the answer in plain words', () => {
    expect(answerText({ type: 'expense', expenseAccount: 'Advertising - ZP' }, 'out', 'card')).toBe('Expense, Advertising');
    expect(answerText({ type: 'supplier_payment', party: { doctype: 'Supplier', name: 'Meta Platforms' } }, 'out', 'bank')).toBe('Supplier payment, Meta Platforms');
    expect(answerText({ type: 'ignore' }, 'out', 'card')).toBe('Ignore this message');
    expect(answerText({ type: 'expense', expenseAccount: 'Advertising - ZP', party: { doctype: 'Supplier', name: 'Meta' } }, 'out', 'card'))
      .toBe('Expense, Advertising, for Meta');
  });

  it('planChoice plans each item with its own account, like the single flow', () => {
    const plan = planChoice({ mappings: [BANK, CARD], company: 'ZP', drawingsAccount: 'Drawings - ZP', today: '2026-11-08' });
    const p = plan(fb('a', 100_000), { type: 'expense', expenseAccount: 'Advertising - ZP' });
    expect(p.steps).toHaveLength(1);
    expect(JSON.stringify(p.steps[0].body)).toContain('IDFC Credit Card - ZP');
    expect(() => plan(fb('b', 100, { currency: 'USD' }), { type: 'expense', expenseAccount: 'Advertising - ZP' })).toThrow();
    expect(plan(fb('c', 100), { type: 'ignore' }).steps).toEqual([]);
  });

  it('automaticRule turns the stored rule on, or builds one from the largest amount done', () => {
    const choice = { type: 'expense' as const, expenseAccount: 'Advertising - ZP' };
    const stored: Rule = { matchKey: 'm:out:facebooksi', action: 'expense', account: 'Advertising - ZP', hits: 3, lastUsed: 5, auto: false, maxAmountMinor: 900, currency: 'INR' };
    expect(automaticRule([stored], 'm:out:facebooksi', choice, [fb('a', 100)])).toEqual({ ...stored, auto: true });
    const built = automaticRule([], 'm:out:facebooksi', choice, [fb('a', 100), fb('b', 700)]);
    expect(built).toMatchObject({ matchKey: 'm:out:facebooksi', action: 'expense', account: 'Advertising - ZP', auto: true, maxAmountMinor: 700, currency: 'INR' });
    // A stored rule with another answer is replaced by this one.
    const other: Rule = { ...stored, account: 'Travel - ZP' };
    expect(automaticRule([other], 'm:out:facebooksi', choice, [fb('a', 100)])).toMatchObject({ account: 'Advertising - ZP', auto: true, maxAmountMinor: 100 });
    expect(automaticRule([], 'm:out:facebooksi', { type: 'salary', party: { doctype: 'Employee', name: 'E' } }, [fb('a', 100)])).toBeNull();
    expect(automaticRule([], 'm:out:facebooksi', choice, [])).toBeNull();
  });
});
