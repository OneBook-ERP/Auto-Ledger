import type { AccountMapping } from '../core/types';
import { buildDrafts, defaultKind, parseLast4, pickDefaultMode, validateDrafts } from './setup';

// Sorted by name ascending, like the ERPNext API: "Bank Draft" comes before "Wire Transfer".
const MODES = [{ name: 'Bank Draft', type: 'Bank' }, { name: 'Cash', type: 'Cash' }, { name: 'Credit Card', type: 'General' }, { name: 'Wire Transfer', type: 'Bank' }];
const ACCOUNTS = [
  { name: 'IDFC First - ZP', glAccount: 'IDFC First - ZP', bankAccountNo: null, isCompanyAccount: true },
  { name: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', bankAccountNo: null, isCompanyAccount: true },
  { name: 'ICICI - ZP', glAccount: 'ICICI - ZP', bankAccountNo: null, isCompanyAccount: true },
];

describe('parseLast4', () => {
  it('accepts comma and space separated groups', () => {
    expect(parseLast4('3455, 8129')).toEqual({ ok: true, value: ['3455', '8129'] });
    expect(parseLast4('3455 8129,6507')).toEqual({ ok: true, value: ['3455', '8129', '6507'] });
  });
  it('removes duplicates', () => expect(parseLast4('3455 3455')).toEqual({ ok: true, value: ['3455'] }));
  it.each(['', '  ', '12345', '12a4', '345', '3455, 81'])('rejects %j', (t) => {
    expect(parseLast4(t).ok).toBe(false);
  });
});

describe('defaults', () => {
  it('kind is card when the name mentions a card', () => {
    expect(defaultKind('IDFC Credit Card - ZP')).toBe('card');
    expect(defaultKind('IndiGo card')).toBe('card');
    expect(defaultKind('IDFC First - ZP')).toBe('bank');
  });
  it('picks a Bank/Wire Transfer mode for bank accounts and a card mode for cards', () => {
    expect(pickDefaultMode(MODES, 'bank')).toBe('Wire Transfer');
    expect(pickDefaultMode(MODES, 'card')).toBe('Credit Card');
    expect(pickDefaultMode([{ name: 'Cash', type: 'Cash' }], 'bank')).toBe('Cash');
    // no Wire Transfer: any Bank-type mode, not a name guess
    expect(pickDefaultMode([{ name: 'Bank Draft', type: 'General' }, { name: 'NEFT', type: 'Bank' }], 'bank')).toBe('NEFT');
    expect(pickDefaultMode([], 'bank')).toBe('');
  });
});

describe('buildDrafts', () => {
  it('presets IDFCFB for IDFC, marks other banks unsupported, defaults kinds and modes', () => {
    const d = buildDrafts(ACCOUNTS, [], MODES);
    expect(d.map((x) => [x.bankAccount, x.supported, x.kind, x.senders, x.modeOfPayment, x.selected])).toEqual([
      ['IDFC First - ZP', true, 'bank', 'IDFCFB', 'Wire Transfer', false],
      ['IDFC Credit Card - ZP', true, 'card', 'IDFCFB', 'Credit Card', false],
      ['ICICI - ZP', false, 'bank', '', 'Wire Transfer', false],
    ]);
  });
  it('prefills from an existing mapping (re-run setup)', () => {
    const m: AccountMapping = { bankAccount: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Cash' };
    const d = buildDrafts(ACCOUNTS, [m], MODES).find((x) => x.bankAccount === m.bankAccount)!;
    expect(d).toMatchObject({ selected: true, last4: '3455, 8129', modeOfPayment: 'Cash', kind: 'card' });
  });
});

describe('bank support uses the Bank Account bank field', () => {
  it('trusts bank over the account name, falling back to the name', () => {
    const d = buildDrafts([
      { name: 'Current ZP', glAccount: 'Current - ZP', bank: 'IDFC First Bank' },
      { name: 'IDFC looking name', glAccount: 'x', bank: 'ICICI Bank' },
      { name: 'IDFC Card', glAccount: 'x', bank: null },
    ], [], MODES);
    expect(d.map((x) => x.supported)).toEqual([true, false, true]);
  });
  it('marks existing mappings as saved', () => {
    const m: AccountMapping = { bankAccount: 'IDFC First - ZP', glAccount: 'g', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Cash' };
    expect(buildDrafts(ACCOUNTS, [m], MODES)[0].saved).toBe(true);
    expect(buildDrafts(ACCOUNTS, [], MODES)[0].saved).toBe(false);
  });
});

describe('validateDrafts', () => {
  it('rejects the same last-4 on two accounts of the same kind, allows it across kinds', () => {
    const d = buildDrafts(ACCOUNTS, [], MODES);
    d[0] = { ...d[0], selected: true, last4: '6507' };
    d[1] = { ...d[1], selected: true, last4: '3455, 6507', kind: 'bank' };
    const r = validateDrafts(d);
    expect(r.errors['IDFC Credit Card - ZP']).toMatch(/6507 are already used by IDFC First - ZP/);
    expect(r.mappings).toHaveLength(1);
    d[1] = { ...d[1], kind: 'card' };
    expect(validateDrafts(d).errors).toEqual({});
  });
  it('builds one mapping with two last-4 groups', () => {
    const d = buildDrafts(ACCOUNTS, [], MODES);
    d[1] = { ...d[1], selected: true, last4: '3455, 8129' };
    const r = validateDrafts(d);
    expect(r.errors).toEqual({});
    expect(r.mappings).toEqual([
      { bankAccount: 'IDFC Credit Card - ZP', glAccount: 'IDFC Credit Card - ZP', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Credit Card' },
    ]);
  });
  it('reports a bad last-4 and requires at least one selected account', () => {
    const d = buildDrafts(ACCOUNTS, [], MODES);
    expect(validateDrafts(d).none).toBe(true);
    d[0] = { ...d[0], selected: true, last4: '12' };
    expect(validateDrafts(d).errors['IDFC First - ZP']).toMatch(/4 digits/);
  });
  it('requires a sender id and a mode of payment', () => {
    const d = buildDrafts(ACCOUNTS, [], []);
    d[0] = { ...d[0], selected: true, last4: '6507', senders: '' };
    const e = validateDrafts(d).errors['IDFC First - ZP'];
    expect(e).toMatch(/sender/i);
  });
});
