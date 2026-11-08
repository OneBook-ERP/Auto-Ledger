// Trust rules for the Home figures (spec section 14). Pure: no I/O, the clock is passed in.

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type TrustInput = {
  lastSyncedAt: number | null;
  now: number;
  unclassifiedCount: number;
  pendingDrafts: { count: number; totalMinor: number };
  computedBankBalanceMinor: number | null;
  smsBalanceMinor: number | null;
};

export type Trust = { incomplete: boolean; reasons: string[]; mismatch: boolean };

export const MISMATCH_REASON = 'Bank balance differs from your latest bank message';

export function buildTrust(i: TrustInput): Trust {
  const reasons: string[] = [];
  let incomplete = false;
  if (i.lastSyncedAt === null) {
    incomplete = true;
    reasons.push('Not synced yet');
  } else if (i.now - i.lastSyncedAt > STALE_AFTER_MS) {
    incomplete = true;
    reasons.push('Not synced for more than a day');
  }
  if (i.unclassifiedCount > 0) {
    incomplete = true;
    reasons.push(i.unclassifiedCount === 1 ? '1 message needs an answer' : `${i.unclassifiedCount} messages need an answer`);
  }
  // Drafts waiting for the accountant are shown separately and never make the figures "incomplete".
  const mismatch = i.computedBankBalanceMinor !== null && i.smsBalanceMinor !== null && i.computedBankBalanceMinor !== i.smsBalanceMinor;
  if (mismatch) reasons.push(MISMATCH_REASON);
  return { incomplete, reasons, mismatch };
}
