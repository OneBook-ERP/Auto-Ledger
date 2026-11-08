import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { Alert, Linking } from 'react-native';
import Inbox, { EMPTY_TITLE } from '../app/(tabs)/inbox';
import AccountStep from '../app/txn/account';
import AmountStep, { RUPEE_LABEL } from '../app/txn/amount';
import ConfirmStep, { IGNORE_MESSAGE, IGNORE_TITLE } from '../app/txn/confirm';
import InvoicesStep from '../app/txn/invoices';
import PartyStep from '../app/txn/party';
import ResultScreen from '../app/txn/result';
import TransactionScreen, { DRAWINGS_MISSING } from '../app/txn/[id]';
import type { AccountMapping, PendingTxn } from '../src/core/types';
import { ErpAuthError, ErpNetworkError, ErpValidationError } from '../src/erp/client';
import { InboxDepsOverride } from '../src/inbox/deps';
import { fakeInboxErp, type FakeInboxErp } from '../src/inbox/fakeErp';
import type { FlowDraft } from '../src/inbox/flow';
import { useFlowStore } from '../src/inbox/store';
import { planFor } from '../src/inbox/flow';
import { submitAnswer } from '../src/inbox/submit';
import { BANK, BANK2, CARD, NOW, smsTxn, txnFrom } from '../src/inbox/testData';
import { runPlan } from '../src/outbox/runner';
import { fakeApp } from '../src/state/testUtils';

const mockRouter = {
  push: jest.fn(), replace: jest.fn(), back: jest.fn(), navigate: jest.fn(), dismissAll: jest.fn(), dismissTo: jest.fn(), canGoBack: jest.fn(() => true),
};
let mockParams: Record<string, string> = {};
const mockFocus = new Set<() => void>();
jest.mock('expo-router', () => {
  const { useEffect } = require('react');
  return {
    useRouter: () => mockRouter,
    useLocalSearchParams: () => mockParams,
    // Runs on mount like a first focus; tests call refocus() to model coming back to a screen.
    useFocusEffect: (cb: () => void) => useEffect(() => {
      mockFocus.add(cb);
      cb();
      return () => {
        mockFocus.delete(cb);
      };
    }, [cb]),
    Redirect: () => null,
    Stack: () => null,
  };
});
jest.mock('../src/state/native', () => ({ getNative: () => ({}) }));

const SITE = 'https://zp.example.app';

async function setup(o: { txns?: PendingTxn[]; mappings?: AccountMapping[]; settings?: Record<string, string>; erp?: FakeInboxErp } = {}) {
  const { Wrap: AppWrap, repo, value } = await fakeApp();
  for (const m of o.mappings ?? [BANK, CARD]) await repo.saveMapping(m);
  for (const t of o.txns ?? []) await repo.upsertPending(t);
  const settings = { company: 'ZP', drawingsAccount: 'Drawings - ZP', defaultExpenseAccount: 'Office Expenses - ZP', ...o.settings };
  for (const [k, v] of Object.entries(settings)) if (v !== '') await repo.setSetting(k, v);
  const erp = o.erp ?? fakeInboxErp();
  const run = jest.fn(runPlan);
  const deps = { erp, now: () => NOW, runPlan: run, siteUrl: SITE };
  const Wrap = ({ children }: { children: ReactNode }) => (
    <AppWrap>
      <InboxDepsOverride.Provider value={deps}>{children}</InboxDepsOverride.Provider>
    </AppWrap>
  );
  return { repo, erp, run, Wrap, runCycle: value.runCycle as jest.Mock };
}

const draft = (id: string, d: FlowDraft) => useFlowStore.getState().start(id, d);
const buttonNames = (container: ReturnType<typeof screen.getByTestId>) =>
  within(container).getAllByRole('button').map((b) => b.props.accessibilityLabel as string);
const refocus = () => act(async () => { mockFocus.forEach((cb) => cb()); });
const lastPush = () => mockRouter.push.mock.calls[mockRouter.push.mock.calls.length - 1]?.[0];

beforeEach(() => {
  Object.values(mockRouter).forEach((f) => f.mockClear());
  mockParams = {};
  useFlowStore.setState({ drafts: {}, flash: null });
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------- Inbox

describe('Inbox', () => {
  it('shows the empty state', async () => {
    const { Wrap } = await setup();
    await render(<Wrap><Inbox /></Wrap>);
    expect(await screen.findByText(EMPTY_TITLE)).toBeTruthy();
    expect(screen.getByTestId('count')).toHaveTextContent('Nothing to answer');
  });

  it('lists new txns newest first with chips, count and the trust line', async () => {
    const credit = txnFrom('idfc-006');
    const google = txnFrom('idfc-034');
    const usd = txnFrom('idfc-040');
    const done = txnFrom('idfc-001', { state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-9', docstatus: 0 }] });
    const { Wrap, repo } = await setup({ txns: [credit, google, usd, done] });
    await repo.saveRule({ matchKey: 'm:out:googleservis', action: 'expense', account: 'Advertising - ZP', hits: 3, lastUsed: 1 });
    await repo.setSetting('last_synced_at', String(NOW - 5 * 60_000));
    await render(<Wrap><Inbox /></Wrap>);
    await screen.findByTestId(`row-${credit.id}`);
    expect(screen.getByTestId('count')).toHaveTextContent('3 to answer');
    expect(screen.getByTestId('trust')).toHaveTextContent('Synced 5 min ago · 1 draft waiting for your accountant');
    const rows = screen.getAllByRole('button').filter((b) => String(b.props.testID ?? '').startsWith('row-'));
    expect(rows.map((r) => r.props.testID)).toEqual([`row-${usd.id}`, `row-${credit.id}`, `row-${google.id}`]);
    expect(within(screen.getByTestId(`row-${credit.id}`)).getByText('Who is this?')).toBeTruthy();
    expect(within(screen.getByTestId(`row-${google.id}`)).getByText('You did this before: Advertising')).toBeTruthy();
    expect(within(screen.getByTestId(`row-${usd.id}`)).getByText('Enter the rupee amount')).toBeTruthy();
    expect(within(screen.getByTestId(`row-${credit.id}`)).getByText('+₹30,000.00')).toBeTruthy();
    expect(screen.getByTestId(`row-${credit.id}`).props.accessibilityLabel).toContain('₹30,000.00 received');
    await fireEvent.press(screen.getByTestId(`row-${credit.id}`));
    expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/[id]', params: { id: credit.id } });
  });

  it('notices: unreadable messages and an unknown account (dismiss clears the flag)', async () => {
    const { Wrap, repo } = await setup();
    await repo.setSetting('unrecognised_count', '2');
    await repo.setSetting('unrecognised_account:4321', String(NOW));
    await render(<Wrap><Inbox /></Wrap>);
    expect(await screen.findByText('2 messages could not be read')).toBeTruthy();
    expect(screen.getByText('Unrecognised account ending 4321: add it in Settings')).toBeTruthy();
    await fireEvent.press(within(screen.getByTestId('unread')).getByRole('button', { name: 'Open Settings' }));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/settings');
    await fireEvent.press(within(screen.getByTestId('unknown-4321')).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByTestId('unknown-4321')).toBeNull());
    expect(await repo.getSetting('unrecognised_account:4321')).toBeNull();
  });

  it('pull to refresh runs the foreground cycle and reloads', async () => {
    const { Wrap, repo, runCycle } = await setup();
    const t = txnFrom('idfc-006');
    runCycle.mockImplementation(async () => { await repo.upsertPending(t); });
    await render(<Wrap><Inbox /></Wrap>);
    await screen.findByText(EMPTY_TITLE);
    await act(async () => { await screen.getByTestId('inbox-list').props.refreshControl.props.onRefresh(); });
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId(`row-${t.id}`)).toBeTruthy();
  });

  it('the autoledger://inbox deep link acts on no query parameters', async () => {
    const t = txnFrom('idfc-006');
    const { Wrap, repo, run } = await setup({ txns: [t] });
    mockParams = { id: t.id, txn: t.id, action: 'ignore', confirm: '1' };
    await render(<Wrap><Inbox /></Wrap>);
    await screen.findByTestId(`row-${t.id}`);
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect((await repo.getPending(t.id))?.state).toBe('new');
    expect(await repo.listOutbox(t.id)).toEqual([]);
  });

  it('shows the "saved, sent later" notice after an offline answer', async () => {
    const { Wrap } = await setup();
    useFlowStore.getState().setFlash('No connection. Your answer is saved and will be sent when you are back online.');
    await render(<Wrap><Inbox /></Wrap>);
    expect(await screen.findByText('No connection. Your answer is saved and will be sent when you are back online.')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- Transaction screen

describe('Transaction screen', () => {
  async function open(t: PendingTxn, o: Parameters<typeof setup>[0] = {}) {
    const s = await setup({ txns: [t], ...o });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    await screen.findByTestId('action-sheet');
    return s;
  }

  it('credit: the credit answers', async () => {
    await open(txnFrom('idfc-006'));
    expect(buttonNames(screen.getByTestId('action-sheet'))).toEqual([
      'Customer advance', 'Payment against an invoice', 'Other income', 'Transfer from my other account', 'Personal', 'Ignore this message',
    ]);
    expect(screen.getByText('₹30,000.00').props.accessibilityLabel).toBe('₹30,000.00 received');
    expect(screen.getByText('SBIN32974781')).toBeTruthy();
  });

  it('bank debit: its own set', async () => {
    await open(txnFrom('idfc-010'));
    expect(buttonNames(screen.getByTestId('action-sheet'))).toEqual([
      'Supplier payment', 'Payment against a bill', 'Expense', 'Salary/Employee payment', 'Transfer between my accounts', 'Personal', 'Ignore this message',
    ]);
  });

  it('card debit: expense first, no transfer', async () => {
    await open(txnFrom('idfc-034'));
    expect(buttonNames(screen.getByTestId('action-sheet'))).toEqual(['Expense', 'Bill paid by card', 'Personal', 'Ignore this message']);
  });

  it('Personal is disabled without a drawings account, with a notice', async () => {
    await open(txnFrom('idfc-010'), { settings: { drawingsAccount: '' } });
    const personal = within(screen.getByTestId('action-sheet')).getByRole('button', { name: 'Personal' });
    expect(personal.props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText(`${DRAWINGS_MISSING} to use Personal.`)).toBeTruthy();
    await fireEvent.press(personal);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('choosing an answer starts the flow at the right step', async () => {
    const t = txnFrom('idfc-006');
    await open(t);
    await fireEvent.press(screen.getByRole('button', { name: 'Customer advance' }));
    expect(lastPush()).toEqual({ pathname: '/txn/party', params: { id: t.id } });
    expect(useFlowStore.getState().drafts[t.id]).toEqual({ mapping: BANK, action: 'customer_advance' });
  });

  it('a foreign-currency card spend asks for the rupee amount first', async () => {
    const t = txnFrom('idfc-040');
    await open(t);
    await fireEvent.press(screen.getByRole('button', { name: 'Expense' }));
    expect(lastPush()).toEqual({ pathname: '/txn/amount', params: { id: t.id } });
    expect(useFlowStore.getState().drafts[t.id].suggestedAccount).toBe('Office Expenses - ZP');
  });

  it('a learned rule is the primary suggestion and goes straight to confirm', async () => {
    const t = txnFrom('idfc-034');
    const s = await setup({ txns: [t] });
    await s.repo.saveRule({ matchKey: 'm:out:googleservis', action: 'expense', account: 'Advertising - ZP', hits: 3, lastUsed: 1 });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    const card = await screen.findByTestId('suggestion');
    expect(card.props.accessibilityLabel).toBe('Suggested: Expense: Advertising. You did this before. Creates a draft journal entry.');
    await fireEvent.press(card);
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
    expect(useFlowStore.getState().drafts[t.id]).toEqual({ mapping: CARD, action: 'expense', account: 'Advertising - ZP' });
  });

  it('unmapped account: asks which saved account first, then offers the answers', async () => {
    const t = txnFrom('idfc-016'); // no last 4, two bank accounts saved
    const s = await setup({ txns: [t], mappings: [BANK, BANK2, CARD] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    expect(await screen.findByText('Which account is this?')).toBeTruthy();
    expect(screen.getByText('The message does not say which of your bank accounts this was. Choose one.')).toBeTruthy();
    // Only Ignore is offered before the account is known (it needs none).
    expect(buttonNames(screen.getByTestId('action-sheet'))).toEqual(['Ignore this message']);
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual(['IDFC First. Ending 6507', 'IDFC Savings. Ending 1111']);
    await fireEvent.press(radios[1]);
    await waitFor(() => expect(buttonNames(screen.getByTestId('action-sheet'))).toContain('Personal'));
    await fireEvent.press(screen.getByRole('button', { name: 'Personal' }));
    expect(useFlowStore.getState().drafts[t.id]).toEqual({ mapping: BANK2, action: 'personal' });
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
  });

  it('an answered txn is not offered again', async () => {
    const t = txnFrom('idfc-006', { state: 'created' });
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    expect(await screen.findByText('Already answered')).toBeTruthy();
    expect(screen.queryByTestId('action-sheet')).toBeNull();
  });
});

// ---------------------------------------------------------------- Steps

describe('rupee amount step', () => {
  it('requires a valid amount, then continues', async () => {
    const t = txnFrom('idfc-040');
    const s = await setup({ txns: [t] });
    draft(t.id, { mapping: CARD, action: 'expense' });
    mockParams = { id: t.id };
    await render(<s.Wrap><AmountStep /></s.Wrap>);
    const field = await screen.findByLabelText(RUPEE_LABEL);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter the rupee amount, for example 8,512.40.');
    expect(mockRouter.push).not.toHaveBeenCalled();
    await fireEvent.changeText(field, '8,512.40');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].inrAmountMinor).toBe(851240);
    expect(lastPush()).toEqual({ pathname: '/txn/account', params: { id: t.id } });
  });
});

describe('party step', () => {
  it('searches (debounced) and picks an existing party', async () => {
    const t = txnFrom('idfc-006');
    const erp = fakeInboxErp();
    erp.searchParties.mockResolvedValue([{ doctype: 'Customer', name: 'CUST-0011', displayName: 'Company Eleven' }]);
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: BANK, action: 'customer_advance' });
    mockParams = { id: t.id };
    await render(<s.Wrap><PartyStep /></s.Wrap>);
    const row = await screen.findByRole('radio', { name: 'Company Eleven. CUST-0011' });
    expect(erp.searchParties).toHaveBeenCalledWith('Customer', 'COMPANY_11');
    expect(erp.searchParties).toHaveBeenCalledTimes(1);
    await fireEvent.press(row);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].party).toEqual({ doctype: 'Customer', name: 'CUST-0011', displayName: 'Company Eleven' });
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
  });

  it('create new: name prefilled, required fields asked, and the plan gets a create_party step', async () => {
    const t = txnFrom('idfc-006');
    const erp = fakeInboxErp();
    erp.getRequiredFields.mockResolvedValue([
      { fieldname: 'customer_name', label: 'Customer Name', fieldtype: 'Data' },
      { fieldname: 'customer_group', label: 'Customer Group', fieldtype: 'Link' },
    ]);
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: BANK, action: 'customer_advance' });
    mockParams = { id: t.id };
    const r = await render(<s.Wrap><PartyStep /></s.Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Create new Customer' }));
    const name = await screen.findByLabelText('Customer name');
    expect(name.props.value).toBe('COMPANY_11');
    const group = await screen.findByLabelText('Customer Group');
    await fireEvent.changeText(name, '  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    expect(screen.getByText('ERPNext needs Customer Group.')).toBeTruthy();
    expect(mockRouter.push).not.toHaveBeenCalled();
    await fireEvent.changeText(name, 'Company Eleven Pvt Ltd');
    await fireEvent.changeText(group, 'Commercial');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
    expect(useFlowStore.getState().drafts[t.id].newParty).toEqual({
      ref: { doctype: 'Customer', name: 'Company Eleven Pvt Ltd' }, fields: { customer_name: 'Company Eleven Pvt Ltd', customer_group: 'Commercial' },
      labels: { customer_group: 'Customer Group' },
    });
    await r.unmount();

    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByText('New Customer')).toBeTruthy();
    expect(screen.getByText('New Customer will be created: Company Eleven Pvt Ltd')).toBeTruthy();
    expect(screen.getByLabelText('Customer Group: Commercial')).toBeTruthy(); // human label, not customer_group
    expect(screen.queryByLabelText('customer_group: Commercial')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    expect(erp.createParty).toHaveBeenCalledWith('Customer', { customer_name: 'Company Eleven Pvt Ltd', customer_group: 'Commercial' });
    expect(s.run.mock.calls[0][1].steps.map((x: { kind: string }) => x.kind)).toEqual(['create_party', 'create_doc']);
  });
});

describe('invoice step', () => {
  it('defaults allocations to the outstanding capped at the amount, and blocks over-allocation', async () => {
    const t = txnFrom('idfc-006'); // ₹30,000 in
    const erp = fakeInboxErp();
    erp.listOpenInvoices.mockResolvedValue([
      { doctype: 'Sales Invoice', name: 'SINV-1', outstandingMinor: 2000000, dueDate: '2026-10-01' },
      { doctype: 'Sales Invoice', name: 'SINV-2', outstandingMinor: 2000000, dueDate: '2026-10-15' },
    ]);
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: BANK, action: 'against_invoice', party: { doctype: 'Customer', name: 'Acme' } });
    mockParams = { id: t.id };
    await render(<s.Wrap><InvoicesStep /></s.Wrap>);
    await fireEvent.press(await screen.findByRole('checkbox', { name: 'SINV-1. ₹20,000.00 still due, due 1 Oct 2026' }));
    await fireEvent.press(screen.getByRole('checkbox', { name: 'SINV-2. ₹20,000.00 still due, due 15 Oct 2026' }));
    expect(screen.getByLabelText('Amount for SINV-1 (₹)').props.value).toBe('20000.00');
    expect(screen.getByLabelText('Amount for SINV-2 (₹)').props.value).toBe('10000.00');
    await fireEvent.changeText(screen.getByLabelText('Amount for SINV-2 (₹)'), '15000');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('You allocated ₹35,000.00, more than the ₹30,000.00 of this transaction. Lower an amount.')).toBeTruthy();
    expect(mockRouter.push).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Amount for SINV-2 (₹)'), '10000');
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].invoices).toEqual([
      { doctype: 'Sales Invoice', name: 'SINV-1', allocatedMinor: 2000000 },
      { doctype: 'Sales Invoice', name: 'SINV-2', allocatedMinor: 1000000 },
    ]);
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
  });
});

describe('account step', () => {
  it('expense: prefilled from the default expense account, saves the choice', async () => {
    const t = txnFrom('idfc-034');
    const erp = fakeInboxErp();
    erp.listLedgerAccounts.mockResolvedValue([{ name: 'Advertising - ZP', accountType: null }, { name: 'Office Expenses - ZP', accountType: null }]);
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: CARD, action: 'expense', suggestedAccount: 'Office Expenses - ZP' });
    mockParams = { id: t.id };
    await render(<s.Wrap><AccountStep /></s.Wrap>);
    expect(await screen.findByRole('radio', { name: 'Office Expenses - ZP', checked: true })).toBeTruthy();
    expect(erp.listLedgerAccounts).toHaveBeenCalledWith('ZP', { rootType: 'Expense' });
    await fireEvent.press(screen.getByRole('radio', { name: 'Advertising - ZP' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].account).toBe('Advertising - ZP');
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
  });
  it('transfer: offers the other saved accounts', async () => {
    const t = txnFrom('idfc-010');
    const s = await setup({ txns: [t] });
    draft(t.id, { mapping: BANK, action: 'transfer' });
    mockParams = { id: t.id };
    await render(<s.Wrap><AccountStep /></s.Wrap>);
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => r.props.accessibilityLabel)).toEqual(['IDFC Credit Card. Card, ending 3455, 8129']);
    await fireEvent.press(radios[0]);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].toAccount).toEqual(CARD);
  });
});

// ---------------------------------------------------------------- Confirm

describe('Confirm', () => {
  const acme = { doctype: 'Customer' as const, name: 'Acme Test Traders' };
  async function openConfirm(d: FlowDraft = { mapping: BANK, action: 'customer_advance', party: acme }, o: Parameters<typeof setup>[0] = {}, t = txnFrom('idfc-006')) {
    const s = await setup({ txns: [t], ...o });
    draft(t.id, d);
    mockParams = { id: t.id };
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    return { ...s, t };
  }

  it('Create draft is disabled until the summary has rendered', async () => {
    const t = txnFrom('idfc-006');
    const s = await setup({ txns: [t] });
    draft(t.id, { mapping: BANK, action: 'customer_advance', party: acme });
    mockParams = { id: t.id };
    const seen: { summary: boolean; enabled: boolean }[] = [];
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    // Every committed state: the button is never enabled without the summary on screen.
    const check = () => {
      const btn = screen.queryByTestId('create');
      if (btn) seen.push({ summary: !!screen.queryByTestId('summary-0'), enabled: !btn.props.accessibilityState.disabled });
    };
    check();
    await screen.findByTestId('summary-0');
    check();
    expect(seen.every((x) => !x.enabled || x.summary)).toBe(true);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    expect(screen.getByText(/^Payment Entry \(draft\): receive ₹30,000.00 from Acme Test Traders as advance/)).toBeTruthy();
    expect(screen.getByText('It is saved as a draft. Your accountant submits it and matches it to the bank statement in ERPNext.')).toBeTruthy();
  });

  it('a planner error is shown in words and nothing can be created', async () => {
    const old = txnFrom('idfc-009', { occurredOn: '2024-01-01' });
    await openConfirm({ mapping: BANK, action: 'customer_advance', party: acme }, {}, old);
    expect(await screen.findByText('This transaction is dated outside the usual range. Check the date in ERPNext.')).toBeTruthy();
    expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(true);
  });

  it('created: runPlan with userAction, rule learned, result shown', async () => {
    const { run, repo, t } = await openConfirm();
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    expect(screen.getByRole('switch', { name: 'Remember this choice' }).props.value).toBe(true);
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    expect(mockRouter.dismissAll).toHaveBeenCalled();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][3]).toEqual({ userAction: true });
    expect((await repo.getPending(t.id))?.state).toBe('created');
    expect(await repo.listRules()).toEqual([{ matchKey: 'cp:in:company11', action: 'customer_advance', party: acme, hits: 1, lastUsed: t.receivedAt }]);
    expect(useFlowStore.getState().drafts[t.id]).toBeUndefined();
  });

  it('remember switched off: no rule', async () => {
    const { repo } = await openConfirm();
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent(screen.getByRole('switch', { name: 'Remember this choice' }), 'valueChange', false);
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
    expect(await repo.listRules()).toEqual([]);
  });

  it('the remember switch is hidden for invoices and transfers', async () => {
    await openConfirm({ mapping: BANK, action: 'transfer', toAccount: CARD }, {}, txnFrom('idfc-010'));
    await screen.findByTestId('summary-0');
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('double tap creates ONE runPlan call', async () => {
    const erp = fakeInboxErp();
    let release!: () => void;
    erp.findDraftByUtr.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    const { run } = await openConfirm(undefined, { erp });
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    const btn = screen.getByTestId('create');
    await act(async () => {
      void fireEvent.press(btn);
      void fireEvent.press(btn);
      void fireEvent.press(btn);
    });
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await act(async () => release());
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalled());
    expect(run).toHaveBeenCalledTimes(1);
    expect(erp.createDraft).toHaveBeenCalledTimes(1);
  });

  it('needs_login: routes to login; the txn stays in the Inbox and the answer stays queued', async () => {
    const erp = fakeInboxErp();
    erp.findDraftByUtr.mockRejectedValue(new ErpAuthError('expired', 401));
    erp.checkSession.mockResolvedValue(false);
    const { repo, t } = await openConfirm(undefined, { erp });
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith('/(auth)/login'));
    expect((await repo.getPending(t.id))?.state).toBe('new');
    expect((await repo.listOutbox(t.id)).map((o) => o.status)).toEqual(['pending']);
    expect((await repo.listPending('new')).map((x) => x.id)).toEqual([t.id]);
    expect(await repo.listRules()).toEqual([]);
  });

  it('a failure lists the missing fields with an Open in ERPNext hint; no rule learned', async () => {
    const erp = fakeInboxErp();
    erp.createDraft.mockRejectedValue(new ErpValidationError('Value missing', 417, ['Gender']));
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    const { repo, t } = await openConfirm(undefined, { erp });
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('create'));
    const panel = await screen.findByTestId('failure');
    expect(panel.props.accessibilityLiveRegion).toBe('assertive');
    expect(within(panel).getByText(/ERPNext needs: Gender/)).toBeTruthy();
    expect(within(panel).getByText(/Could not create the Payment Entry/)).toBeTruthy();
    await fireEvent.press(within(panel).getByRole('button', { name: 'Open in ERPNext' }));
    expect(openURL).toHaveBeenCalledWith(`${SITE}/app/payment-entry/new`);
    expect((await repo.getPending(t.id))?.state).toBe('new');
    expect(await repo.listRules()).toEqual([]);
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('retryable failure: saved and queued, back to the Inbox with a notice', async () => {
    const erp = fakeInboxErp();
    erp.createDraft.mockRejectedValue(new ErpNetworkError('offline'));
    const { repo, t } = await openConfirm(undefined, { erp });
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/inbox'));
    expect(useFlowStore.getState().flash).toBe('No connection. Your answer is saved and will be sent when you are back online.');
    expect((await repo.getPending(t.id))?.state).toBe('new');
    expect((await repo.listOutbox(t.id)).map((o) => o.status)).toEqual(['pending']);
    expect(await repo.listRules()).toEqual([]);
  });

  it('ignore: confirm dialog, then the txn is ignored (and remembered)', async () => {
    const alert = jest.spyOn(Alert, 'alert');
    alert.mockImplementationOnce((_t, _m, buttons) => buttons?.find((b) => b.text === 'Cancel')?.onPress?.());
    const { run, repo, t } = await openConfirm({ mapping: BANK, action: 'ignore' });
    expect(await screen.findByText('Nothing will be added to ERPNext. AutoLedger will not ask about this message again.')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ignore this message' }).props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByRole('button', { name: 'Ignore this message' }));
    expect(alert).toHaveBeenCalledWith(IGNORE_TITLE, IGNORE_MESSAGE, expect.any(Array), expect.anything());
    expect(run).not.toHaveBeenCalled();
    alert.mockImplementationOnce((_t, _m, buttons) => buttons?.find((b) => b.text === 'Ignore')?.onPress?.());
    await fireEvent.press(screen.getByRole('button', { name: 'Ignore this message' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    expect(run.mock.calls[0][3]).toEqual({ userAction: true });
    expect((await repo.getPending(t.id))?.state).toBe('ignored');
    expect((await repo.listRules())[0]).toMatchObject({ action: 'ignore' });
  });


  it('Change my answer returns to the transaction', async () => {
    const { t } = await openConfirm();
    await fireEvent.press(await screen.findByRole('button', { name: 'Change my answer' }));
    expect(mockRouter.dismissTo).toHaveBeenCalledWith({ pathname: '/txn/[id]', params: { id: t.id } });
  });
});

// ---------------------------------------------------------------- Result

describe('Result', () => {
  it('shows the documents, offers the next item and the ERPNext link', async () => {
    const t = txnFrom('idfc-006', { state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-2026-00041', docstatus: 0 }] });
    const a = txnFrom('idfc-034');
    const b = txnFrom('idfc-040');
    const s = await setup({ txns: [t, a, b] });
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    mockParams = { id: t.id };
    await render(<s.Wrap><ResultScreen /></s.Wrap>);
    expect(await screen.findByText('Draft created')).toBeTruthy();
    expect(screen.getByText('ACC-PAY-2026-00041')).toBeTruthy();
    expect(screen.getByText('Waiting for your accountant')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Next: ANTHROPIC* CLAUDE SUB, 2 left' }));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/txn/[id]', params: { id: b.id } });
    await fireEvent.press(screen.getByRole('button', { name: 'Open in ERPNext' }));
    expect(openURL).toHaveBeenCalledWith(`${SITE}/app/payment-entry/ACC-PAY-2026-00041`);
    await fireEvent.press(screen.getByRole('button', { name: 'See it in Activity' }));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/activity');
  });
  it('nothing left: back to the Inbox', async () => {
    const t = txnFrom('idfc-006', { state: 'ignored' });
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id };
    await render(<s.Wrap><ResultScreen /></s.Wrap>);
    expect(await screen.findByText('Message ignored')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Back to Inbox' }));
    expect(mockRouter.navigate).toHaveBeenCalledWith('/(tabs)/inbox');
  });
});

// ---------------------------------------------------------------- Fix round 1 (R53)

describe('credit transfer from another own account (R52b)', () => {
  it('transaction -> account step (company Bank Accounts) -> confirm summary -> runPlan with fromAccount and userAction', async () => {
    const t = txnFrom('idfc-006');
    const erp = fakeInboxErp();
    erp.listBankAccounts.mockResolvedValue([
      { name: 'IDFC First - ZP', glAccount: 'IDFC First - ZP', isCompanyAccount: true }, // this account
      { name: 'ICICI Savings - ZP', glAccount: 'ICICI - ZP', isCompanyAccount: true },
      { name: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', isCompanyAccount: true },
      { name: 'Acme - HDFC', glAccount: 'Debtors - ZP', isCompanyAccount: false }, // a customer's bank account
    ]);
    const s = await setup({ txns: [t], erp });
    mockParams = { id: t.id };
    const a = await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Transfer from my other account' }));
    expect(lastPush()).toEqual({ pathname: '/txn/account', params: { id: t.id } });
    await a.unmount();

    const b = await render(<s.Wrap><AccountStep /></s.Wrap>);
    expect(await screen.findByText('Which account did the money come from?')).toBeTruthy();
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((x) => x.props.accessibilityLabel)).toEqual([
      'ICICI Savings. ICICI - ZP', 'IDFC Credit Card. IDFC Credit Card - ZP. AutoLedger reads its messages.',
    ]);
    expect(erp.listBankAccounts).toHaveBeenCalledWith('ZP');
    await fireEvent.press(radios[0]);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(useFlowStore.getState().drafts[t.id].fromAccount).toEqual({ bankAccount: 'ICICI Savings - ZP', glAccount: 'ICICI - ZP' });
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
    await b.unmount();

    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByText(/^Internal transfer: ₹30,000.00 from ICICI - ZP into IDFC First - ZP/)).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull(); // transfers are never remembered
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    const [, plan, , opts] = s.run.mock.calls[0];
    expect(opts).toEqual({ userAction: true });
    expect(plan.steps[0].body).toMatchObject({ payment_type: 'Internal Transfer', paid_from: 'ICICI - ZP', paid_to: 'IDFC First - ZP', mode_of_payment: 'Wire Transfer', reference_no: 'SBIN32974781' });
    expect(await s.repo.listRules()).toEqual([]);
  });
});

describe('thrown errors on the submit path (R53 I1)', () => {
  const acme = { doctype: 'Customer' as const, name: 'Acme Test Traders' };
  async function ready(t = txnFrom('idfc-006')) {
    const s = await setup({ txns: [t] });
    draft(t.id, { mapping: BANK, action: 'customer_advance', party: acme });
    mockParams = { id: t.id };
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    return { ...s, t };
  }
  it('runPlan rejects, txn still new: a readable error, the button works again', async () => {
    const { run, repo, t } = await ready();
    run.mockImplementationOnce(async () => { throw new Error('SQLITE_IOERR'); });
    await fireEvent.press(screen.getByTestId('create'));
    const panel = await screen.findByTestId('failure');
    expect(within(panel).getByText(/Your answer may not have been saved; check the Inbox and Activity before trying again/)).toBeTruthy();
    expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false);
    expect((await repo.getPending(t.id))?.state).toBe('new');
    expect(mockRouter.push).not.toHaveBeenCalled();
  });
  it('runPlan rejects after the txn became created: goes to Result', async () => {
    const { run, repo, t } = await ready();
    run.mockImplementationOnce(async () => {
      await repo.upsertPending({ ...t, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-5', docstatus: 0 }] });
      throw new Error('write lost');
    });
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
  });
  it('runPlan rejects because the txn is gone: notice and back to the Inbox', async () => {
    const { run, repo, t } = await ready();
    run.mockImplementationOnce(async (...args: Parameters<typeof runPlan>) => {
      await repo.resetForNewSite();
      return runPlan(...args); // the real runner: "Transaction ... not found"
    });
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.dismissTo).toHaveBeenCalledWith('/(tabs)/inbox'));
    expect(useFlowStore.getState().flash).toBe('This message is no longer in your Inbox.');
    expect(useFlowStore.getState().drafts[t.id]).toBeUndefined();
  });
});

describe('while a submit runs (R53 3b)', () => {
  const acme = { doctype: 'Customer' as const, name: 'Acme Test Traders' };
  it('Back and Change my answer are disabled, the transaction screen says it is still sending', async () => {
    const t = txnFrom('idfc-006');
    const erp = fakeInboxErp();
    let release!: () => void;
    erp.findDraftByUtr.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: BANK, action: 'customer_advance', party: acme });
    mockParams = { id: t.id };
    await render(<s.Wrap><ConfirmStep /><TransactionScreen /></s.Wrap>);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await act(async () => { void fireEvent.press(screen.getByTestId('create')); }); // the handler is still running
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back to Back' }).props.accessibilityState.disabled).toBe(true));
    expect(screen.getByRole('button', { name: 'Change my answer' }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getAllByTestId('sending').length).toBe(2); // confirm + transaction screen
    expect(within(screen.getByTestId('action-sheet')).getByRole('button', { name: 'Customer advance' }).props.accessibilityState.disabled).toBe(true);
    await act(async () => release());
    await waitFor(() => expect(mockRouter.push).toHaveBeenCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    expect(screen.queryAllByTestId('sending')).toHaveLength(0);
  });
  it('a run that finishes after its screen is gone neither navigates nor clears a newer draft', async () => {
    const t = txnFrom('idfc-006');
    const erp = fakeInboxErp();
    let release!: () => void;
    erp.findDraftByUtr.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));
    erp.createDraft.mockRejectedValueOnce(new ErpNetworkError('offline'));
    const s = await setup({ txns: [t], erp });
    draft(t.id, { mapping: BANK, action: 'customer_advance', party: acme });
    mockParams = { id: t.id };
    const r = await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await act(async () => { void fireEvent.press(screen.getByTestId('create')); }); // the handler is still running
    await waitFor(() => expect(erp.findDraftByUtr).toHaveBeenCalled());
    await r.unmount();
    draft(t.id, { mapping: BANK, action: 'personal' }); // the user started a newer answer meanwhile
    await act(async () => release());
    await waitFor(() => expect(useFlowStore.getState().flash).not.toBeNull());
    expect(mockRouter.dismissTo).not.toHaveBeenCalled();
    expect(mockRouter.push).not.toHaveBeenCalled();
    expect(useFlowStore.getState().drafts[t.id]).toEqual({ mapping: BANK, action: 'personal' });
  });
});

describe('foreign-currency confirm and result (R53 3a)', () => {
  it('shows the rupee value with the implied rate; warns only on an obvious slip', async () => {
    const t = txnFrom('idfc-040'); // USD 100.00
    const s = await setup({ txns: [t] });
    draft(t.id, { mapping: CARD, action: 'expense', account: 'Software - ZP', inrAmountMinor: 850000 });
    mockParams = { id: t.id };
    const r = await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByLabelText('Card amount: USD 100.00, entered as ₹8,500.00 (₹85.00 per USD)')).toBeTruthy();
    expect(screen.queryByTestId('rate-warning')).toBeNull();
    await r.unmount();
    draft(t.id, { mapping: CARD, action: 'expense', account: 'Software - ZP', inrAmountMinor: 85000000 }); // 8,50,000 typed for 8,500
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByTestId('rate-warning')).toHaveTextContent(/₹8,500.00 per USD, which looks unusual/);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false)); // soft: still allowed
  });
  it('the result sentence leads with the rupee value', async () => {
    const t = txnFrom('idfc-040', { state: 'created', createdDocs: [{ doctype: 'Journal Entry', name: 'JV-1', docstatus: 0 }] });
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id, inr: '850000' };
    await render(<s.Wrap><ResultScreen /></s.Wrap>);
    expect(await screen.findByText('₹8,500.00 (USD 100.00) to ANTHROPIC* CLAUDE SUB is now in ERPNext as a draft.')).toBeTruthy();
  });
});

describe('ignore without an account or company (R53 3d)', () => {
  it('an unmapped message can be ignored straight away', async () => {
    const t = txnFrom('idfc-016');
    const s = await setup({ txns: [t], mappings: [BANK, BANK2], settings: { company: '' } });
    mockParams = { id: t.id };
    const a = await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Ignore this message' }));
    expect(useFlowStore.getState().drafts[t.id]).toEqual({ action: 'ignore' });
    expect(lastPush()).toEqual({ pathname: '/txn/confirm', params: { id: t.id } });
    await a.unmount();
    jest.spyOn(Alert, 'alert').mockImplementationOnce((_t, _m, buttons) => buttons?.find((x) => x.text === 'Ignore')?.onPress?.());
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Ignore this message' }).props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByRole('button', { name: 'Ignore this message' }));
    await waitFor(() => expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/txn/result', params: { id: t.id } }));
    expect((await s.repo.getPending(t.id))?.state).toBe('ignored');
  });
  it('a last-4 that no longer resolves gets honest copy', async () => {
    const t = txnFrom('idfc-006'); // ends 6507
    const s = await setup({ txns: [t], mappings: [BANK2] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    expect(await screen.findByText('No saved account ends in 6507 any more. Choose the one this message belongs to.')).toBeTruthy();
  });
});

describe('navigation guards and robustness (R53 3f-3h)', () => {
  it('a double tap on an Inbox row pushes once', async () => {
    const t = txnFrom('idfc-006');
    const { Wrap } = await setup({ txns: [t] });
    await render(<Wrap><Inbox /></Wrap>);
    const row = await screen.findByTestId(`row-${t.id}`);
    await act(async () => {
      void fireEvent.press(row);
      void fireEvent.press(row);
    });
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });
  it('a double tap on an answer pushes once', async () => {
    const t = txnFrom('idfc-006');
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    const btn = await screen.findByRole('button', { name: 'Customer advance' });
    await act(async () => {
      void fireEvent.press(btn);
      void fireEvent.press(btn);
    });
    expect(mockRouter.push).toHaveBeenCalledTimes(1);
  });
  it('pull to refresh survives a rejecting cycle', async () => {
    const { Wrap, runCycle } = await setup();
    runCycle.mockRejectedValueOnce(new Error('boom'));
    await render(<Wrap><Inbox /></Wrap>);
    await screen.findByText(EMPTY_TITLE);
    await act(async () => { await screen.getByTestId('inbox-list').props.refreshControl.props.onRefresh(); });
    expect(screen.getByTestId('inbox-list').props.refreshControl.props.refreshing).toBe(false);
  });
  it('Result "Next" skips a txn whose answer is already queued', async () => {
    const done = txnFrom('idfc-006', { state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 }] });
    const queued = txnFrom('idfc-040'); // newest
    const plain = txnFrom('idfc-034');
    const s = await setup({ txns: [done, queued, plain] });
    await s.repo.enqueue({ id: 'q1', txnId: queued.id, plan: { steps: [], summary: [], needsInrAmount: false }, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    mockParams = { id: done.id };
    await render(<s.Wrap><ResultScreen /></s.Wrap>);
    expect(await screen.findByRole('button', { name: 'Next: GOOGLESERVIS, 1 left' })).toBeTruthy();
  });
});

describe('R54 follow-ups on screens', () => {
  const creditOnSavings = (receivedAt: number, time = '10:05') =>
    smsTxn('idfc-001', [['XXXXX996507', 'XXXXX991111'], ['INR 12,932.00', 'INR 30,000.00'], ['02/09/26 09:13', `19/10/26 ${time}`]], receivedAt);
  /** ERPNext fake that keeps drafts and finds them by reference. */
  const statefulErp = () => {
    const erp = fakeInboxErp();
    const docs: { name: string; body: Record<string, unknown> }[] = [];
    erp.createDraft.mockImplementation(async (_dt, body) => {
      const name = `ACC-PAY-000${docs.length + 1}`;
      docs.push({ name, body });
      return { name };
    });
    erp.findDraftByUtr.mockImplementation(async (ref) => {
      const d = docs.find((x) => x.body.reference_no === ref);
      return d ? { doctype: 'Payment Entry', name: d.name, docstatus: 0 } : null;
    });
    return { erp, docs };
  };
  /** Books a debit leg (current -> savings) through the real planner, submit path and runner. */
  const bookDebit = async (repo: Parameters<typeof submitAnswer>[0]['repo'], erp: FakeInboxErp, t: PendingTxn) => {
    const { plan, choice } = planFor(t, { mapping: BANK, action: 'transfer', toAccount: BANK2 }, { company: 'ZP', drawingsAccount: '', today: '2026-10-20' });
    expect((await submitAnswer({ repo, erp, runPlan }, { txn: t, plan, choice, remember: false })).kind).toBe('created');
  };
  const fromCurrent = { bankAccount: BANK.bankAccount, glAccount: BANK.glAccount, modeOfPayment: BANK.modeOfPayment };

  it('Confirm links a credit transfer to the debit leg already recorded, and the runner adopts its entry', async () => {
    const debit = txnFrom('idfc-010');
    const credit = creditOnSavings(debit.receivedAt + 60_000);
    const { erp, docs } = statefulErp();
    const s = await setup({ txns: [debit, credit], mappings: [BANK, BANK2, CARD], erp });
    await bookDebit(s.repo, erp, debit);
    draft(credit.id, { mapping: BANK2, action: 'transfer', fromAccount: fromCurrent });
    mockParams = { id: credit.id };
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByLabelText("Linked: Linked to the transfer already recorded from IDFC First's message (ACC-PAY-0001)")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    await fireEvent.press(screen.getByTestId('create'));
    await waitFor(() => expect(mockRouter.push).toHaveBeenLastCalledWith({ pathname: '/txn/result', params: { id: credit.id } }));
    expect(s.run.mock.calls[0][1].steps[0].body.reference_no).toBe('IDFB6292M4509651');
    expect(docs).toHaveLength(1);
    expect(erp.createDraft).toHaveBeenCalledTimes(1); // the debit leg's own create only
    expect((await s.repo.getPending(credit.id))!.createdDocs).toEqual([{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0, adopted: true }]);
  });
  it('Confirm warns when several transfers match and does not link', async () => {
    const debit = txnFrom('idfc-010');
    const debit2 = smsTxn('idfc-010', [['IDFB6292M4509651', 'IDFB6292M4509999']], debit.receivedAt + 3_600_000);
    const credit = creditOnSavings(debit.receivedAt + 60_000);
    const { erp } = statefulErp();
    const s = await setup({ txns: [debit, debit2, credit], mappings: [BANK, BANK2, CARD], erp });
    await bookDebit(s.repo, erp, debit);
    await bookDebit(s.repo, erp, debit2);
    draft(credit.id, { mapping: BANK2, action: 'transfer', fromAccount: fromCurrent });
    mockParams = { id: credit.id };
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    expect(await screen.findByText('Several matching transfers were found. Check ERPNext for duplicates after creating.')).toBeTruthy();
    expect(screen.queryByTestId('linked')).toBeNull();
    expect(screen.getByText(new RegExp(`UTR/ref AL-${credit.rawHash}`))).toBeTruthy();
  });
  it('a customer receipt on the other account is never offered as the linked leg', async () => {
    const acme = smsTxn('idfc-006', [['XXXXXXX6507', 'XXXXXXX1111'], ['05-11-2026', '19-10-2026']], txnFrom('idfc-010').receivedAt + 60_000);
    const debit = txnFrom('idfc-010');
    const { erp } = statefulErp();
    const s = await setup({ txns: [acme, debit], mappings: [BANK, BANK2, CARD], erp });
    const r = planFor(acme, { mapping: BANK2, action: 'customer_advance', party: { doctype: 'Customer', name: 'Acme' } }, { company: 'ZP', drawingsAccount: '', today: '2026-10-20' });
    await submitAnswer({ repo: s.repo, erp, runPlan }, { txn: acme, plan: r.plan, choice: r.choice, remember: false });
    draft(debit.id, { mapping: BANK, action: 'transfer', toAccount: BANK2 });
    mockParams = { id: debit.id };
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    expect(screen.queryByTestId('linked')).toBeNull();
    expect(screen.getByText(/UTR\/ref IDFB6292M4509651/)).toBeTruthy();
  });
  it('an error outcome keeps the computed link (no flicker, no re-lookup)', async () => {
    const debit = txnFrom('idfc-010');
    const credit = creditOnSavings(debit.receivedAt + 60_000);
    const { erp } = statefulErp();
    const s = await setup({ txns: [debit, credit], mappings: [BANK, BANK2, CARD], erp });
    await bookDebit(s.repo, erp, debit);
    draft(credit.id, { mapping: BANK2, action: 'transfer', fromAccount: fromCurrent });
    mockParams = { id: credit.id };
    const lookups = jest.spyOn(s.repo, 'listActiveOutbox');
    await render(<s.Wrap><ConfirmStep /></s.Wrap>);
    await screen.findByTestId('linked');
    await waitFor(() => expect(screen.getByTestId('create').props.accessibilityState.disabled).toBe(false));
    const n = lookups.mock.calls.length;
    s.run.mockImplementationOnce(async () => ({ status: 'failed', retryable: false, error: new ErpValidationError('Party is disabled', 417) }));
    await fireEvent.press(screen.getByTestId('create'));
    await screen.findByTestId('failure');
    expect(screen.getByTestId('linked')).toBeTruthy();
    expect(lookups.mock.calls.length).toBe(n);
  });
  it('the Transaction screen re-reads on focus: an answer that finished elsewhere shows "Already answered"', async () => {
    const t = txnFrom('idfc-006');
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    await screen.findByTestId('action-sheet');
    await s.repo.upsertPending({ ...t, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 }] });
    // The re-read is held: the stale answer list must already be gone while it runs.
    let releaseRead!: () => void;
    const realGet = s.repo.getPending;
    jest.spyOn(s.repo, 'getPending').mockImplementationOnce(async (x) => { await new Promise<void>((r) => { releaseRead = r; }); return realGet(x); });
    await refocus();
    expect(screen.queryByTestId('action-sheet')).toBeNull();
    await act(async () => releaseRead());
    expect(await screen.findByText('Already answered')).toBeTruthy();
    expect(screen.queryByTestId('action-sheet')).toBeNull();
  });
  it('and when a send for the txn ends while the screen is open', async () => {
    const t = txnFrom('idfc-006');
    const s = await setup({ txns: [t] });
    mockParams = { id: t.id };
    await render(<s.Wrap><TransactionScreen /></s.Wrap>);
    await screen.findByTestId('action-sheet');
    await act(async () => useFlowStore.getState().setSending(t.id, true));
    await s.repo.upsertPending({ ...t, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 }] });
    await act(async () => useFlowStore.getState().setSending(t.id, false));
    expect(await screen.findByText('Already answered')).toBeTruthy();
  });
});
