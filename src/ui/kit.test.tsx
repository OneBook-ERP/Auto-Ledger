import { fireEvent, render, screen, within } from '@testing-library/react-native';
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: (p: { behavior?: string; children?: unknown }) => <View testID="kav" accessibilityHint={`behavior:${p.behavior}`}>{p.children as never}</View> };
});
import { Banner, Button, ChoiceRow, Screen, StepHeader, TextField } from '.';

it('Screen renders title, body and footer', async () => {
  await render(<Screen title="Sign in" subtitle="to ERPNext" footer={<Button label="Go" onPress={() => {}} />}><Banner message="hello" /></Screen>);
  expect(screen.getByRole('header', { name: 'Sign in' })).toBeTruthy();
  expect(screen.getByText('hello')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Go' })).toBeTruthy();
});

it('Button ignores presses while loading', async () => {
  const onPress = jest.fn();
  await render(<Button label="Save" onPress={onPress} loading />);
  await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
  expect(onPress).not.toHaveBeenCalled();
});

it('TextField secret toggles visibility with an accessible Show/Hide button', async () => {
  await render(<TextField label="Password" secret value="x" onChangeText={() => {}} />);
  expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(true);
  await fireEvent.press(screen.getByRole('button', { name: 'Show password' }));
  expect(screen.getByLabelText('Password').props.secureTextEntry).toBe(false);
  expect(screen.getByRole('button', { name: 'Hide password' })).toBeTruthy();
});

it('TextField shows an error as an alert', async () => {
  await render(<TextField label="Site" error="Enter your ERPNext site address." />);
  expect(screen.getByRole('alert')).toHaveTextContent('Enter your ERPNext site address.');
});

it('ChoiceRow exposes checked state', async () => {
  await render(<ChoiceRow title="Company A" selected onPress={() => {}} />);
  expect(screen.getByRole('radio', { checked: true })).toBeTruthy();
});

it('StepHeader reads as "Step 2 of 4"', async () => {
  await render(<StepHeader step={2} total={4} label="Accounts" />);
  expect(screen.getByText('Step 2 of 4')).toBeTruthy();
});

describe('announcements on Android', () => {
  it('Banner sets a live region: assertive for errors, polite otherwise', async () => {
    await render(<><Banner tone="error" message="bad" testID="e" /><Banner tone="info" message="fyi" testID="i" /><Banner tone="warn" message="hmm" testID="w" /></>);
    expect(screen.getByTestId('e').props.accessibilityLiveRegion).toBe('assertive');
    expect(screen.getByTestId('i').props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByTestId('w').props.accessibilityLiveRegion).toBe('polite');
  });
  it('TextField error is a live region and is part of the input hint', async () => {
    await render(<TextField label="Site" hint="Your ERPNext address." error="Enter your ERPNext site address." />);
    expect(screen.getByRole('alert').props.accessibilityLiveRegion).toBe('assertive');
    expect(screen.getByLabelText('Site').props.accessibilityHint).toBe('Enter your ERPNext site address. Your ERPNext address.');
  });
});

describe('Screen keyboard handling', () => {
  it('pads for the keyboard; taps keep working in the scroll view; the footer stays inside the avoiding view', async () => {
    await render(<Screen title="T" footer={<Button label="Go" onPress={() => {}} />}><Banner message="x" /></Screen>);
    const kav = screen.getByTestId('kav');
    expect(kav.props.accessibilityHint).toBe('behavior:padding');
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).toContain('"keyboardShouldPersistTaps":"handled"');
    // both the scroll view and the footer button are descendants of the avoiding view
    expect(within(kav).getByRole('button', { name: 'Go' })).toBeTruthy();
    expect(within(kav).getByRole('header', { name: 'T' })).toBeTruthy();
  });
});
