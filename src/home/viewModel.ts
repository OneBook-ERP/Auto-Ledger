// Home view-model: pure, built from fetched figures + local data. The screen only renders it.
import { buildTrust, type Trust } from '../core/trust';
import type { AccountMapping, PendingTxn } from '../core/types';
import { resolveMapping } from '../ingest/pipeline';
import type { CycleSummary } from '../ingest/pipeline';
import { formatInr } from '../ui/format';

export const DASH = '—';
export const HOME_CACHE_KEY = 'home_cache';
export const LAST_SYNCED_KEY = 'last_synced_at';

export type HomeFigures = { balances: Record<string, number | null>; receivableMinor: number | null; payableMinor: number | null };
export type HomeCache = { at: number; site: string; balances: Record<string, number>; receivableMinor: number; payableMinor: number };

export type HomeInputs = {
  mappings: AccountMapping[];
  pending: PendingTxn[];
  /** Null when nothing was ever fetched and there is no cache. */
  figures: HomeFigures | null;
  figuresAt: number | null;
  /** True when `figures` came from the cache because ERPNext could not be reached. */
  figuresStale: boolean;
  lastSyncedAt: number | null;
  now: number;
};

export type HomeModel = {
  hasFigures: boolean;
  bank: {
    accounts: { name: string; glAccount: string; minor: number | null; text: string }[];
    /** Only with more than one bank account. */
    total: { minor: number | null; text: string } | null;
  };
  /** Net of advances. A negative net is shown as an absolute amount under a different label. */
  receivable: { label: string; text: string };
  payable: { label: string; text: string };
  drafts: {
    count: number;
    inCount: number;
    inMinor: number;
    outCount: number;
    outMinor: number;
    /** "₹2,00,000.00 in · ₹30,466.00 out"; a side with no items is left out. Empty when there are no rupee drafts. */
    summaryText: string;
    otherCurrencyCount: number;
    footnote: string | null;
  };
  unclassifiedCount: number;
  smsBalanceMinor: number | null;
  trust: Trust;
  /** "as of 1 hour ago" when the figures are from the cache. */
  asOfLabel: string | null;
  couldNotRefresh: boolean;
  lastSyncedText: string;
};

const inrText = (m: number | null) => (m === null || !Number.isFinite(m) ? DASH : formatInr(m));
/** Whole rupees for the tiles, rounding half away from zero; a real but tiny amount is never shown as zero. */
export function wholeText(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return DASH;
  const abs = Math.abs(m);
  if (abs > 0 && abs < 50) return 'under ₹1';
  return formatInr(Math.sign(m) * Math.round(abs / 100) * 100).replace(/\.\d\d$/, '');
}

function tile(m: number | null, positive: string, negative: string): { label: string; text: string } {
  if (m !== null && Number.isFinite(m) && m < 0) return { label: negative, text: wholeText(-m) };
  return { label: positive, text: wholeText(m) };
}

/** A cycle counts as "synced" only if every step worked and the outbox drain finished (not stuck on retry/login). */
export function cycleCountsAsSynced(s: (CycleSummary & { skipped?: unknown }) | null): boolean {
  return !!s && !s.skipped && s.failedSteps.length === 0 && (s.drain?.stoppedBecause === 'empty' || s.drain?.stoppedBecause === 'limit');
}

export function relativeTime(now: number, then: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return 'just now';
  const plural = (n: number, u: string) => `${n} ${u}${n === 1 ? '' : 's'} ago`;
  if (s < 3600) return plural(Math.floor(s / 60), 'minute');
  if (s < 86400) return plural(Math.floor(s / 3600), 'hour');
  return plural(Math.floor(s / 86400), 'day');
}

export function buildHomeModel(i: HomeInputs): HomeModel {
  const banks = i.mappings.filter((m) => m.kind === 'bank');
  const accounts = banks.map((m) => {
    const raw = i.figures?.balances[m.glAccount];
    const minor = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return { name: m.bankAccount, glAccount: m.glAccount, minor, text: inrText(minor) };
  });
  const totalMinor = accounts.length > 1 && accounts.every((a) => a.minor !== null) ? accounts.reduce((s, a) => s + (a.minor as number), 0) : null;
  const total = accounts.length > 1 ? { minor: totalMinor, text: inrText(totalMinor) } : null;

  const created = i.pending.filter((t) => t.state === 'created');
  const inr = created.filter((t) => t.currency === 'INR');
  const otherCurrencyCount = created.length - inr.length;
  // amountMinor is unsigned: money in and money out are never added together.
  const ins = inr.filter((t) => t.direction === 'in');
  const outs = inr.filter((t) => t.direction === 'out');
  const sum = (a: PendingTxn[]) => a.reduce((n, t) => n + t.amountMinor, 0);
  const inMinor = sum(ins);
  const outMinor = sum(outs);
  const summaryText = [ins.length ? `${formatInr(inMinor)} in` : null, outs.length ? `${formatInr(outMinor)} out` : null].filter(Boolean).join(' · ');
  // 'failed' items also wait for the user, so they count as unanswered.
  const unclassifiedCount = i.pending.filter((t) => t.state === 'new' || t.state === 'failed').length;

  // Newest bank message with a balance, per mapped bank account. A cached (stale) ERP balance is never
  // compared with a fresh message: that would raise a false alarm.
  let pair: { computed: number; sms: number } | null = null;
  if (!i.figuresStale) {
    for (const [idx, m] of banks.entries()) {
      const computed = accounts[idx].minor;
      if (computed === null) continue;
      const mine = i.pending.filter((t) => t.accountType === 'bank' && resolveMapping(i.mappings, t) === m);
      // Items not yet in the ledger make a difference expected: do not compare this account.
      if (mine.some((t) => t.state === 'new' || t.state === 'created')) continue;
      const newest = mine.filter((t) => t.currency === 'INR' && t.balanceMinor !== null).sort((x, y) => y.receivedAt - x.receivedAt)[0];
      if (!newest || newest.balanceMinor === null) continue;
      const cand = { computed, sms: newest.balanceMinor };
      if (cand.computed !== cand.sms) {
        pair = cand;
        break;
      }
      pair ??= cand;
    }
  }

  const trust = buildTrust({
    lastSyncedAt: i.lastSyncedAt,
    now: i.now,
    unclassifiedCount,
    pendingDrafts: { count: created.length, totalMinor: inMinor + outMinor },
    computedBankBalanceMinor: pair?.computed ?? null,
    smsBalanceMinor: pair?.sms ?? null,
  });

  return {
    hasFigures: i.figures !== null,
    bank: { accounts, total },
    receivable: tile(i.figures?.receivableMinor ?? null, 'To receive', 'Advances received'),
    payable: tile(i.figures?.payableMinor ?? null, 'To pay', 'Advances paid'),
    drafts: {
      count: created.length,
      inCount: ins.length,
      inMinor,
      outCount: outs.length,
      outMinor,
      summaryText,
      otherCurrencyCount,
      footnote: otherCurrencyCount > 0 ? `plus ${otherCurrencyCount} in other currencies` : null,
    },
    unclassifiedCount,
    smsBalanceMinor: pair?.sms ?? null,
    trust,
    asOfLabel: i.figuresStale && i.figuresAt !== null ? `as of ${relativeTime(i.now, i.figuresAt)}` : null,
    couldNotRefresh: i.figuresStale,
    lastSyncedText: i.lastSyncedAt === null ? 'Not synced yet' : `Last synced ${relativeTime(i.now, i.lastSyncedAt)}`,
  };
}

export function serializeHomeCache(c: HomeCache): string {
  return JSON.stringify(c);
}

/** Tolerant: anything unreadable, or saved for another site, is no cache. */
export function parseHomeCache(raw: string | null, site: string): HomeCache | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<HomeCache>;
    const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (!c || c.site !== site || !num(c.at) || !num(c.receivableMinor) || !num(c.payableMinor) || !c.balances || typeof c.balances !== 'object') return null;
    if (!Object.values(c.balances).every(num)) return null;
    return { at: c.at, site: c.site, balances: c.balances, receivableMinor: c.receivableMinor, payableMinor: c.payableMinor };
  } catch {
    return null;
  }
}
