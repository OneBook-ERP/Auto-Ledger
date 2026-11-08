import { formatInr, formatMoney } from './format';

describe('formatInr', () => {
  it.each([
    [1293200, '₹12,932.00'],
    [51293276, '₹5,12,932.76'],
    [0, '₹0.00'],
    [5, '₹0.05'],
    [99999, '₹999.99'],
    [100000, '₹1,000.00'],
    [1234567890, '₹1,23,45,678.90'],
    [-51293276, '-₹5,12,932.76'],
  ])('%p minor -> %p', (minor, want) => {
    expect(formatInr(minor)).toBe(want);
  });
});

it('formatMoney uses rupees for INR and the ISO code otherwise', () => {
  expect(formatMoney(12345, 'INR')).toBe('₹123.45');
  expect(formatMoney(12345, 'USD')).toBe('USD 123.45');
  expect(formatMoney(-500, 'usd')).toBe('-USD 5.00');
});
