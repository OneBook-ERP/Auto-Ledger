// Pure helpers for the setup wizard (spec 7.2): turning ERPNext Bank Accounts plus the user's choices into
// AccountMappings. No I/O here.
import type { AccountMapping } from '../core/types';
import { ALL_TIME_DAYS, BACKFILL_CHOICES, DEFAULT_BACKFILL_DAYS } from '../ingest/pipeline';

export type AccountDraft = {
  bankAccount: string;
  glAccount: string;
  /** Only IDFC templates exist, so other banks cannot be selected yet. */
  supported: boolean;
  selected: boolean;
  /** Already saved as a mapping: it cannot be removed from the app yet, so it stays selected. */
  saved: boolean;
  kind: 'bank' | 'card';
  /** Comma/space separated sender ids as typed. */
  senders: string;
  /** Comma/space separated 4-digit groups as typed. */
  last4: string;
  modeOfPayment: string;
};

export const IDFC_SENDER = 'IDFCFB';
export const NOT_SUPPORTED = 'This bank is not supported yet';

export type Last4Result = { ok: true; value: string[] } | { ok: false; error: string };

export function parseLast4(text: string): Last4Result {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length === 0) return { ok: false, error: 'Enter the last 4 digits of the account or card number.' };
  const out: string[] = [];
  for (const p of parts) {
    if (!/^\d{4}$/.test(p)) return { ok: false, error: 'Each entry must be exactly 4 digits. Separate several with commas.' };
    if (!out.includes(p)) out.push(p);
  }
  return { ok: true, value: out };
}

export const parseSenders = (text: string): string[] => [...new Set(text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))];

export const defaultKind = (name: string): 'bank' | 'card' => (/card/i.test(name) ? 'card' : 'bank');
export const isSupportedBank = (name: string): boolean => /idfc/i.test(name);

export function pickDefaultMode(modes: { name: string; type?: string | null }[], kind: 'bank' | 'card'): string {
  if (kind === 'card') {
    const card = modes.find((m) => /card/i.test(m.name));
    if (card) return card.name;
  }
  // ERPNext lists modes by name, so "Bank Draft" would win a prefix match: prefer the exact usual one, then any Bank type.
  return (modes.find((m) => m.name === 'Wire Transfer') ?? modes.find((m) => m.type === 'Bank') ?? modes[0])?.name ?? '';
}

export function buildDrafts(
  accounts: { name: string; glAccount: string; bank?: string | null }[],
  existing: AccountMapping[],
  modes: { name: string; type?: string | null }[],
): AccountDraft[] {
  return accounts.map((a) => {
    const m = existing.find((x) => x.bankAccount === a.name);
    const supported = isSupportedBank(a.bank || a.name);
    if (m) {
      return {
        bankAccount: a.name, glAccount: m.glAccount || a.glAccount, supported: true, selected: true, saved: true, kind: m.kind,
        senders: m.senderIds.join(', '), last4: m.last4.join(', '), modeOfPayment: m.modeOfPayment,
      };
    }
    const kind = defaultKind(a.name);
    return {
      bankAccount: a.name, glAccount: a.glAccount, supported, selected: false, saved: false, kind,
      senders: supported ? IDFC_SENDER : '', last4: '', modeOfPayment: pickDefaultMode(modes, kind),
    };
  });
}

export function validateDrafts(drafts: AccountDraft[]): { mappings: AccountMapping[]; errors: Record<string, string>; none: boolean } {
  const mappings: AccountMapping[] = [];
  const errors: Record<string, string> = {};
  const chosen = drafts.filter((d) => d.selected);
  const owner = new Map<string, string>(); // `${kind}:${last4}` -> account that claimed it
  for (const d of chosen) {
    let clash: string | undefined;
    const last4 = parseLast4(d.last4);
    const senderIds = parseSenders(d.senders);
    if (!last4.ok) errors[d.bankAccount] = last4.error;
    else if (senderIds.length === 0) errors[d.bankAccount] = 'Enter the sender id the bank uses, for example IDFCFB.';
    else if (!d.modeOfPayment) errors[d.bankAccount] = 'Choose a default mode of payment.';
    else if ((clash = last4.value.find((x) => owner.has(`${d.kind}:${x}`)))) {
      errors[d.bankAccount] = `Digits ${clash} are already used by ${owner.get(`${d.kind}:${clash}`)}. Each card or account number can belong to one account only.`;
    } else {
      for (const x of last4.value) owner.set(`${d.kind}:${x}`, d.bankAccount);
      mappings.push({ bankAccount: d.bankAccount, glAccount: d.glAccount, kind: d.kind, senderIds, last4: last4.value, modeOfPayment: d.modeOfPayment });
    }
  }
  return { mappings, errors, none: chosen.length === 0 };
}

/** How far back the first (and later) scan of the phone's messages reads. Days match BACKFILL_CHOICES. */
export const BACKFILL_OPTIONS: { days: number; label: string }[] = [
  { days: 7, label: '1 week' },
  { days: 30, label: '1 month' },
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: ALL_TIME_DAYS, label: 'All time' },
];
// Keep the labelled options and the pipeline choices in step (BACKFILL_CHOICES is the one definition).
if (BACKFILL_OPTIONS.some((o, i) => o.days !== BACKFILL_CHOICES[i]) || BACKFILL_OPTIONS.length !== BACKFILL_CHOICES.length) {
  throw new Error('BACKFILL_OPTIONS must match BACKFILL_CHOICES');
}

export const TRUNCATED_NOTICE = 'Showing the newest 5,000 messages. Older ones were not read.';

/** First point of the SMS disclosure for the chosen window. Always limited to the senders the user set up. */
export function windowDisclosure(days: number): string {
  if (days === ALL_TIME_DAYS) {
    return 'It reads all your messages from the banks you set up in the last step, however old, and never messages from anyone else. You can change it later in Settings.';
  }
  return 'It reads only text messages from the bank senders you set up in the last step, and only from the period you choose below. You can change it later in Settings.';
}

export const backfillLabel = (days: number): string =>
  (BACKFILL_OPTIONS.find((o) => o.days === days) ?? BACKFILL_OPTIONS.find((o) => o.days === DEFAULT_BACKFILL_DAYS)!).label;

/** "Found N transactions" from the counts a backfill returns (everything it read, new or already known). */
export function foundMessage(r: { inserted: number; enriched: number; duplicates: number; truncated?: boolean }): string {
  const n = r.inserted + r.enriched + r.duplicates;
  const base = n === 0 ? 'No transactions found' : `Found ${n} ${n === 1 ? 'transaction' : 'transactions'}`;
  return r.truncated ? `${base}. ${TRUNCATED_NOTICE}` : base;
}
