import { buildTrust, STALE_AFTER_MS } from './trust';

const base = { lastSyncedAt: 1_000_000, now: 1_000_000 + 1000, unclassifiedCount: 0, pendingDrafts: { count: 0, totalMinor: 0 }, computedBankBalanceMinor: null, smsBalanceMinor: null };

describe('buildTrust', () => {
  it('is complete when synced recently and nothing unanswered', () => {
    expect(buildTrust(base)).toEqual({ incomplete: false, reasons: [], mismatch: false });
  });
  it('24 h exactly is not stale; 24 h + 1 ms is', () => {
    expect(buildTrust({ ...base, now: base.lastSyncedAt + STALE_AFTER_MS }).incomplete).toBe(false);
    const r = buildTrust({ ...base, now: base.lastSyncedAt + STALE_AFTER_MS + 1 });
    expect(r.incomplete).toBe(true);
    expect(r.reasons).toEqual(['Not synced for more than a day']);
  });
  it('never synced is incomplete', () => {
    expect(buildTrust({ ...base, lastSyncedAt: null })).toEqual({ incomplete: true, reasons: ['Not synced yet'], mismatch: false });
  });
  it('unclassified messages make it incomplete, singular and plural', () => {
    expect(buildTrust({ ...base, unclassifiedCount: 1 }).reasons).toEqual(['1 message needs an answer']);
    expect(buildTrust({ ...base, unclassifiedCount: 4 }).reasons).toEqual(['4 messages need an answer']);
    expect(buildTrust({ ...base, unclassifiedCount: 4 }).incomplete).toBe(true);
  });
  it('lists stale and unclassified reasons together', () => {
    expect(buildTrust({ ...base, lastSyncedAt: null, unclassifiedCount: 2 }).reasons).toEqual(['Not synced yet', '2 messages need an answer']);
  });
  it('drafts alone do not make it incomplete', () => {
    expect(buildTrust({ ...base, pendingDrafts: { count: 3, totalMinor: 13046600 } })).toEqual({ incomplete: false, reasons: [], mismatch: false });
  });
  it('mismatch only when both balances are known and differ exactly', () => {
    const m = buildTrust({ ...base, computedBankBalanceMinor: 100, smsBalanceMinor: 101 });
    expect(m.mismatch).toBe(true);
    expect(m.reasons).toEqual(['Bank balance differs from your latest bank message']);
    expect(m.incomplete).toBe(false);
    expect(buildTrust({ ...base, computedBankBalanceMinor: 100, smsBalanceMinor: 100 }).mismatch).toBe(false);
    expect(buildTrust({ ...base, computedBankBalanceMinor: null, smsBalanceMinor: 100 }).mismatch).toBe(false);
    expect(buildTrust({ ...base, computedBankBalanceMinor: 100, smsBalanceMinor: null }).mismatch).toBe(false);
    expect(buildTrust({ ...base, computedBankBalanceMinor: 0, smsBalanceMinor: 0 }).mismatch).toBe(false);
  });
});
