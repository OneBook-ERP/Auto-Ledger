import type { Rule } from '../core/types';
import { buildInboxModel, kindIconOf, type InboxInputs } from './model';
import { BANK, CARD, NOW, txnFrom } from './testData';

const base = (over: Partial<InboxInputs> = {}): InboxInputs => ({
  pending: [], mappings: [BANK, CARD], rules: [], createdCount: 0, unreadCount: 0, unknownAccounts: [],
  lastSyncedAt: null, now: NOW, queuedIds: [], ...over,
});

describe('buildInboxModel', () => {
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
    expect(ra).toMatchObject({ title: 'COMPANY_11', amountText: '+₹30,000.00', amountA11y: '₹30,000.00 received', direction: 'in', chip: { text: 'Who is this?', tone: 'plain' } });
    expect(ra.subtitle).toBe('Credit · IDFC First …6507 · 5 Nov'); // the long-format credit has no time
    expect(rb.chip).toEqual({ text: 'You did this before: Advertising', tone: 'accent' });
    expect(rb.subtitle.startsWith('Card spend · IDFC Credit Card …3455 · ')).toBe(true);
    expect(rc.chip).toEqual({ text: 'Enter the rupee amount', tone: 'warn' });
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
    expect(buildInboxModel(base({ pending: [t], queuedIds: [t.id] })).rows[0].chip).toEqual({ text: 'Answer saved, waiting to send', tone: 'plain' });
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
    expect(m.rows.find((r) => r.id === 'm')?.chip.text).toBe('What was this?');
    expect(m.rows.find((r) => r.id === 'p')?.chip.text).toBe('Who is this?');
  });
  it('leading icon by kind', () => {
    expect(kindIconOf({ kind: 'card_spend', counterparty: null })).toBe('card');
    expect(kindIconOf({ kind: 'card_si_paid', counterparty: null })).toBe('card');
    expect(kindIconOf({ kind: 'neft_confirm', counterparty: 'ACME' })).toBe('bank');
    expect(kindIconOf({ kind: 'ca_debit', counterparty: 'ravi@okbank' })).toBe('upi');
  });
});
