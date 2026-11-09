import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Alert } from 'react-native';
import Settings from '../app/(tabs)/settings';
import RulesScreen from '../app/rules';
import type { Rule } from '../src/core/types';
import { fakeInboxErp } from '../src/inbox/fakeErp';
import { BANK, CARD, NOW, txnFrom } from '../src/inbox/testData';
import { runAutoApply } from '../src/ingest/autoApply';
import { runPlan } from '../src/outbox/runner';
import { useUiStore } from '../src/state/store';
import { fakeApp } from '../src/state/testUtils';

const mockPush = jest.fn();
jest.mock('expo-router', () => {
  const { Text: T } = require('react-native');
  return {
    useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn() }),
    useFocusEffect: (cb: () => void) => require('react').useEffect(cb, [cb]),
    Redirect: ({ href }: { href: string }) => <T testID="redirect">{href}</T>,
  };
});
jest.mock('../src/state/native', () => ({ getNative: () => ({}) }));

const KEY = 'm:out:facebooksi';
const FB: Rule = { matchKey: KEY, action: 'expense', account: 'Advertising - ZP', hits: 7, lastUsed: 1, auto: true, maxAmountMinor: 300_000, currency: 'INR' };
const SALARY: Rule = { matchKey: 'cp:out:ravi', action: 'salary', party: { doctype: 'Employee', name: 'Ravi K' }, hits: 1, lastUsed: 1, auto: false };
const signedIn = { boot: 'ready' as const, session: { siteUrl: 'https://zp.example.app', user: 'a@b.co' }, setupDone: true };

async function setup(rules: Rule[] = [FB, SALARY]) {
  useUiStore.setState({ ...useUiStore.getInitialState(), ...signedIn });
  const app = await fakeApp();
  for (const r of rules) await app.repo.saveRule(r);
  await app.repo.upsertPending(txnFrom('idfc-035', { id: 'old', state: 'created', createdDocs: [{ doctype: 'Journal Entry', name: 'JE-1', docstatus: 0 }] }));
  return app;
}

beforeEach(() => {
  mockPush.mockClear();
  jest.restoreAllMocks();
});

describe('Automatic rules screen', () => {
  it('lists each pattern with its answer and use count; a switch only where automatic answers are allowed', async () => {
    const app = await setup();
    await render(<app.Wrap><RulesScreen /></app.Wrap>);
    const fb = await screen.findByTestId(`rule-${KEY}`);
    expect(within(fb).getByText('Payments to FACEBOOK SI')).toBeTruthy();
    expect(within(fb).getByText('Expense, Advertising')).toBeTruthy();
    expect(within(fb).getByText('Used 7 times')).toBeTruthy();
    expect(within(fb).getByRole('switch', { name: 'Do this automatically' }).props.value).toBe(true);
    const salary = screen.getByTestId('rule-cp:out:ravi');
    expect(within(salary).getByText('Used 1 time')).toBeTruthy();
    expect(within(salary).queryByRole('switch')).toBeNull();
    expect(within(salary).getByText(/one payment at a time/)).toBeTruthy();
  });

  it('turning a rule off stops the next automatic run and leaves drafts already made alone', async () => {
    const app = await setup();
    await app.repo.upsertPending(txnFrom('idfc-035', { id: 'new1', rawHash: 'n1', amountMinor: 100_000 }));
    await render(<app.Wrap><RulesScreen /></app.Wrap>);
    const sw = within(await screen.findByTestId(`rule-${KEY}`)).getByRole('switch', { name: 'Do this automatically' });
    await fireEvent(sw, 'valueChange', false);
    await waitFor(async () => expect((await app.repo.listRules()).find((r) => r.matchKey === KEY)?.auto).toBe(false));
    const erp = fakeInboxErp();
    expect((await runAutoApply({ repo: app.repo, erp, runPlan, now: () => NOW })).done).toEqual([]);
    expect(erp.createDraft).not.toHaveBeenCalled();
    expect(erp.deleteDraft).not.toHaveBeenCalled();
    expect((await app.repo.getPending('old'))?.state).toBe('created');
    expect((await app.repo.listRules()).find((r) => r.matchKey === KEY)).toMatchObject({ hits: 7, maxAmountMinor: 300_000 });
  });

  it('Delete asks first, then removes only that rule', async () => {
    const app = await setup();
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, b) => b?.find((x) => x.text === 'Delete')?.onPress?.());
    await render(<app.Wrap><RulesScreen /></app.Wrap>);
    await fireEvent.press(within(await screen.findByTestId(`rule-${KEY}`)).getByRole('button', { name: 'Delete' }));
    expect(Alert.alert).toHaveBeenCalledWith('Delete this rule?', expect.stringContaining('Drafts already created are not changed'), expect.anything(), expect.anything());
    await waitFor(() => expect(screen.queryByTestId(`rule-${KEY}`)).toBeNull());
    expect((await app.repo.listRules()).map((r) => r.matchKey)).toEqual(['cp:out:ravi']);
  });

  it('no rules yet', async () => {
    const app = await setup([]);
    await render(<app.Wrap><RulesScreen /></app.Wrap>);
    expect(await screen.findByText('No saved answers yet')).toBeTruthy();
  });

  it('signed out: sends the user to sign in', async () => {
    const app = await setup();
    useUiStore.setState({ session: null });
    await render(<app.Wrap><RulesScreen /></app.Wrap>);
    expect(screen.getByTestId('redirect')).toHaveTextContent('/(auth)/login');
  });

  it('Settings has an "Automatic rules" row that opens the screen', async () => {
    const app = await setup();
    await render(<app.Wrap><Settings /></app.Wrap>);
    await fireEvent.press(await screen.findByRole('button', { name: 'Automatic rules' }));
    expect(mockPush).toHaveBeenCalledWith('/rules');
  });
});
