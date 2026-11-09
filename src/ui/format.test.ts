import { formatDate, formatInr, formatMoney, friendlyDoctype, signedMoney } from './format';

describe('formatInr', () => {
  it.each([
    [1293200, '₹12,932.00'],
    [51293276, '₹5,12,932.76'],
    [0, '₹0.00'],
    [5, '₹0.05'],
    [99999, '₹999.99'],
    [100000, '₹1,000.00'],
    [1234567890, '₹1,23,45,678.90'],
    [-51293276, '\u2212₹5,12,932.76'],
  ])('%p minor -> %p', (minor, want) => {
    expect(formatInr(minor)).toBe(want);
  });
});

it('formatMoney uses rupees for INR and the ISO code otherwise', () => {
  expect(formatMoney(12345, 'INR')).toBe('₹123.45');
  expect(formatMoney(12345, 'USD')).toBe('USD 123.45');
  expect(formatMoney(-500, 'usd')).toBe('\u2212USD 5.00');
});

it('uses one date format and one minus everywhere', () => {
  expect(formatDate('2026-11-06')).toBe('6 Nov 2026');
  expect(signedMoney(50000, 'INR', 'out')).toBe('\u2212₹500.00');
  expect(signedMoney(50000, 'INR', 'in')).toBe('+₹500.00');
  expect(signedMoney(10000, 'USD', 'out')).toBe('\u2212USD 100.00');
  for (const v of [formatInr(-500), formatMoney(-500, 'USD'), signedMoney(500, 'INR', 'out')]) expect(v).not.toMatch(/-₹|-USD/);
  expect(friendlyDoctype('Payment Entry')).toBe('Payment entry');
  expect(friendlyDoctype('Journal Entry')).toBe('Journal entry');
});
