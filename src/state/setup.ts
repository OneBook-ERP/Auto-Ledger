// Pure helpers for the setup wizard (spec 7.2): turning ERPNext Bank Accounts plus the user's choices into
// AccountMappings. No I/O here.
import type { AccountMapping } from '../core/types';

export type AccountDraft = {
  bankAccount: string;
  glAccount: string;
  /** Only IDFC templates exist, so other banks cannot be selected yet. */
  supported: boolean;
  selected: boolean;
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
  const re = kind === 'card' ? /card/i : /bank|wire transfer/i;
  return (modes.find((m) => re.test(m.name)) ?? modes.find((m) => /bank|wire transfer/i.test(m.name)) ?? modes[0])?.name ?? '';
}

export function buildDrafts(
  accounts: { name: string; glAccount: string }[],
  existing: AccountMapping[],
  modes: { name: string; type?: string | null }[],
): AccountDraft[] {
  return accounts.map((a) => {
    const m = existing.find((x) => x.bankAccount === a.name);
    const supported = isSupportedBank(a.name) || isSupportedBank(a.glAccount);
    if (m) {
      return {
        bankAccount: a.name, glAccount: m.glAccount || a.glAccount, supported: true, selected: true, kind: m.kind,
        senders: m.senderIds.join(', '), last4: m.last4.join(', '), modeOfPayment: m.modeOfPayment,
      };
    }
    const kind = defaultKind(a.name);
    return {
      bankAccount: a.name, glAccount: a.glAccount, supported, selected: false, kind,
      senders: supported ? IDFC_SENDER : '', last4: '', modeOfPayment: pickDefaultMode(modes, kind),
    };
  });
}

export function validateDrafts(drafts: AccountDraft[]): { mappings: AccountMapping[]; errors: Record<string, string>; none: boolean } {
  const mappings: AccountMapping[] = [];
  const errors: Record<string, string> = {};
  const chosen = drafts.filter((d) => d.selected);
  for (const d of chosen) {
    const last4 = parseLast4(d.last4);
    const senderIds = parseSenders(d.senders);
    if (!last4.ok) errors[d.bankAccount] = last4.error;
    else if (senderIds.length === 0) errors[d.bankAccount] = 'Enter the sender id the bank uses, for example IDFCFB.';
    else if (!d.modeOfPayment) errors[d.bankAccount] = 'Choose a default mode of payment.';
    else mappings.push({ bankAccount: d.bankAccount, glAccount: d.glAccount, kind: d.kind, senderIds, last4: last4.value, modeOfPayment: d.modeOfPayment });
  }
  return { mappings, errors, none: chosen.length === 0 };
}
