/**
 * Parse an amount such as `INR 5,12,932.76`, `Rs. 115,000.00`, `Rs 8,000.00`,
 * `USD 100.00` into integer minor units. No floating point: digits and the
 * decimal part are handled as strings.
 */
export function parseMinor(text: string): number {
  const m = /(\d[\d,]*)(?:\.(\d*))?/.exec(text);
  if (!m) throw new Error(`parseMinor: no amount in "${text}"`);
  const whole = m[1].replace(/,/g, '');
  const frac = ((m[2] ?? '') + '00').slice(0, 2);
  return parseInt(whole, 10) * 100 + parseInt(frac, 10);
}
