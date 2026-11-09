// WCAG 2.x contrast of every text/background colour pair the UI kit uses, in light and dark.
const cfg = require('../../tailwind.config.js') as { theme: { extend: { colors: Record<string, Record<string, string> | string> } } };
const C = cfg.theme.extend.colors as Record<string, Record<string, string>>;

const lum = (hex: string) => {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const tok = (name: string): string => {
  if (name === 'white') return '#FFFFFF';
  const [group, variant] = name.split('.');
  return C[group][variant ?? 'DEFAULT'];
};

// [text token, background token, minimum ratio]. 3:1 only for 24 px+ text (titles, Money).
const LIGHT: [string, string, number][] = [
  ['ink', 'paper', 4.5], ['ink', 'surface', 4.5], ['muted', 'paper', 4.5], ['muted', 'surface', 4.5],
  ['accent', 'surface', 4.5], ['accent', 'paper', 4.5], ['accent', 'accent.soft', 4.5], ['white', 'accent', 4.5],
  ['danger', 'surface', 4.5], ['danger', 'paper', 4.5], ['danger', 'danger.soft', 4.5], ['ink', 'danger.soft', 4.5],
  ['warn', 'warn.soft', 4.5], ['ink', 'warn.soft', 4.5], ['ok', 'surface', 4.5], ['ok', 'ok.soft', 4.5], ['ink', 'ok.soft', 4.5],
  ['ink', 'accent.soft', 4.5], ['money-in', 'surface', 4.5], ['money-out', 'surface', 4.5], ['money-in', 'paper', 4.5], ['money-out', 'paper', 4.5],
];
const DARK: [string, string, number][] = [
  ['ink.dark', 'paper.dark', 4.5], ['ink.dark', 'surface.dark', 4.5], ['muted.dark', 'paper.dark', 4.5], ['muted.dark', 'surface.dark', 4.5],
  ['accent.dark', 'surface.dark', 4.5], ['accent.dark', 'paper.dark', 4.5], ['accent.dark', 'accent.soft-dark', 4.5], ['paper.dark', 'accent.dark', 4.5],
  ['danger.dark', 'surface.dark', 4.5], ['danger.dark', 'paper.dark', 4.5], ['danger.dark', 'danger.soft-dark', 4.5], ['ink.dark', 'danger.soft-dark', 4.5],
  ['warn.dark', 'warn.soft-dark', 4.5], ['ink.dark', 'warn.soft-dark', 4.5], ['ok.dark', 'surface.dark', 4.5], ['ok.dark', 'ok.soft-dark', 4.5], ['ink.dark', 'ok.soft-dark', 4.5],
  ['ink.dark', 'accent.soft-dark', 4.5], ['money-in.dark', 'surface.dark', 4.5], ['money-out.dark', 'surface.dark', 4.5],
  ['money-in.dark', 'paper.dark', 4.5], ['money-out.dark', 'paper.dark', 4.5],
];

describe('WCAG contrast of the colour tokens', () => {
  it.each(LIGHT)('light: %s on %s >= %s:1', (fg, bg, min) => {
    expect(ratio(tok(fg), tok(bg))).toBeGreaterThanOrEqual(min);
  });
  it.each(DARK)('dark: %s on %s >= %s:1', (fg, bg, min) => {
    expect(ratio(tok(fg), tok(bg))).toBeGreaterThanOrEqual(min);
  });
  it('the old light-only status colours would have failed in dark mode (guard against regression)', () => {
    expect(ratio('#B42318', tok('surface.dark'))).toBeLessThan(3);
    expect(ratio('#8A5300', tok('warn.soft-dark'))).toBeLessThan(3);
    expect(ratio('#0F6B3F', tok('ok.soft-dark'))).toBeLessThan(3);
  });
});
