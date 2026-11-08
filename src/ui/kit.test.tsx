import { fireEvent, render, screen } from '@testing-library/react-native';
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
