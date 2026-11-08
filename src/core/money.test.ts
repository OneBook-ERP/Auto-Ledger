import { parseMinor } from './money';

describe('parseMinor', () => {
  it('parses Indian grouping with INR prefix', () => {
    expect(parseMinor('INR 5,12,932.76')).toBe(51293276);
  });
  it('parses western grouping with Rs. prefix', () => {
    expect(parseMinor('Rs. 115,000.00')).toBe(11500000);
  });
  it('parses Rs prefix without dot', () => {
    expect(parseMinor('Rs 8,000.00')).toBe(800000);
  });
  it('parses ungrouped amounts', () => {
    expect(parseMinor('INR 78948.53')).toBe(7894853);
  });
  it('parses foreign currency prefix', () => {
    expect(parseMinor('USD 100.00')).toBe(10000);
  });
  it('handles one-decimal and no-decimal amounts', () => {
    expect(parseMinor('INR 22129.3')).toBe(2212930);
    expect(parseMinor('INR 500')).toBe(50000);
  });
  it('throws when there are no digits', () => {
    expect(() => parseMinor('INR')).toThrow();
  });
});
