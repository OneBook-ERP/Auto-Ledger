import { render, screen } from '@testing-library/react-native';
import { ListRow } from './ListRow';

it('renders title, subtitle and right text', async () => {
  await render(<ListRow title="Swiggy" subtitle="Card ending 1234" right="₹450.00" />);
  expect(screen.getByText('Swiggy')).toBeTruthy();
  expect(screen.getByText('Card ending 1234')).toBeTruthy();
  expect(screen.getByText('₹450.00')).toBeTruthy();
});
