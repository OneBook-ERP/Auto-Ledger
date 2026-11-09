import {
  accountLabel, amountA11y, dateTimeLabel, istToday, kindLabel, relativeAgo, shortAccount, signedAmount, titleOf, whenLabel,
} from './format';
import { BANK, CARD, NOW, txnFrom } from './testData';

describe('istToday', () => {
  it('is the date in Asia/Kolkata, not UTC', () => {
    expect(istToday(Date.UTC(2026, 10, 7, 18, 29))).toBe('2026-11-07'); // 23:59 IST
    expect(istToday(Date.UTC(2026, 10, 7, 18, 30))).toBe('2026-11-08'); // 00:00 IST
    expect(istToday(NOW)).toBe('2026-11-08');
  });
});

describe('amounts', () => {
  it('signed rupees: + for money in, minus sign for money out', () => {
    expect(signedAmount(txnFrom('idfc-006'))).toBe('+₹30,000.00');
    expect(signedAmount(txnFrom('idfc-010'))).toBe('−₹30,000.00');
  });
  it('foreign currency keeps its code and western grouping', () => {
    expect(signedAmount(txnFrom('idfc-040'))).toBe('−USD 100.00');
  });
  it('accessibility label names the currency and the direction', () => {
    expect(amountA11y(txnFrom('idfc-006'))).toBe('₹30,000.00 received');
    expect(amountA11y(txnFrom('idfc-010'))).toBe('₹30,000.00 paid');
    expect(amountA11y(txnFrom('idfc-040'))).toBe('USD 100.00 paid');
  });
});

describe('labels', () => {
  it('shortAccount drops the company abbreviation suffix', () => {
    expect(shortAccount('IDFC First - ZP')).toBe('IDFC First');
    expect(shortAccount('Advertising Expenses - ZP')).toBe('Advertising Expenses');
    expect(shortAccount('Plain')).toBe('Plain');
  });
  it('account label from the mapping and the last 4 of the message', () => {
    expect(accountLabel(txnFrom('idfc-006'), BANK)).toBe('IDFC First …6507');
    expect(accountLabel(txnFrom('idfc-033'), CARD)).toBe('IDFC Credit Card …3455');
    expect(accountLabel(txnFrom('idfc-016'), BANK)).toBe('IDFC First');
    expect(accountLabel(txnFrom('idfc-006'), null)).toBe('Account not set');
  });
  it('title: counterparty, then merchant, then a plain fallback', () => {
    expect(titleOf(txnFrom('idfc-006'))).toBe('COMPANY_11');
    expect(titleOf(txnFrom('idfc-034'))).toBe('GOOGLESERVIS');
    expect(titleOf(txnFrom('idfc-001'))).toBe('Money received');
    expect(titleOf(txnFrom('idfc-003'))).toBe('Money paid');
  });
  it('kind labels', () => {
    expect(kindLabel('ca_credit')).toBe('Credit');
    expect(kindLabel('ca_debit')).toBe('Debit');
    expect(kindLabel('neft_confirm')).toBe('NEFT');
    expect(kindLabel('card_spend')).toBe('Card spend');
    expect(kindLabel('card_si_paid')).toBe('Standing instruction');
  });
  it('when: time today, "yesterday", else the date', () => {
    const t = { ...txnFrom('idfc-006'), occurredOn: '2026-11-08', occurredTime: '10:42' };
    expect(whenLabel(t, '2026-11-08')).toBe('10:42 am');
    expect(whenLabel({ ...t, occurredOn: '2026-11-07', occurredTime: '18:02' }, '2026-11-08')).toBe('yesterday 6:02 pm');
    expect(whenLabel({ ...t, occurredOn: '2026-11-05', occurredTime: '00:05' }, '2026-11-08')).toBe('5 Nov, 12:05 am');
    expect(whenLabel({ ...t, occurredOn: '2025-12-07', occurredTime: null }, '2026-11-08')).toBe('7 Dec 2025');
    expect(whenLabel({ ...t, occurredOn: '2026-11-08', occurredTime: '12:30' }, '2026-11-08')).toBe('12:30 pm');
  });
  it('full date and time for the transaction screen', () => {
    expect(dateTimeLabel({ ...txnFrom('idfc-006'), occurredOn: '2026-11-08', occurredTime: '10:42' })).toBe('8 Nov 2026, 10:42 am');
    expect(dateTimeLabel({ ...txnFrom('idfc-006'), occurredOn: '2026-11-08', occurredTime: null })).toBe('8 Nov 2026');
  });
  it('relativeAgo', () => {
    expect(relativeAgo(NOW, NOW - 20_000)).toBe('just now');
    expect(relativeAgo(NOW, NOW - 2 * 60_000)).toBe('2 min ago');
    expect(relativeAgo(NOW, NOW - 3 * 3600_000)).toBe('3 h ago');
    expect(relativeAgo(NOW, NOW - 2 * 86400_000)).toBe('2 days ago');
    expect(relativeAgo(NOW, NOW - 86400_000)).toBe('1 day ago');
  });
});
