// Data hooks for the Inbox and the flow screens. Thin: loading and wiring only; decisions live in the pure modules.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { suggest } from '../core/suggest';
import type { AccountMapping, OpenInvoice, PartyRef, PendingTxn, Rule, Suggestion } from '../core/types';
import { UNRECOGNISED_COUNT_KEY, resolveMapping, unrecognisedAccountKey } from '../ingest/pipeline';
import { COMPANY_KEY, DEFAULT_EXPENSE_KEY, DRAWINGS_KEY } from '../state/useSetting';
import type { Step } from './actions';
import { useInboxDeps } from './deps';
import type { FlowDraft } from './flow';
import { LAST_SYNCED_KEY, buildInboxModel, newestFirst, type InboxModel } from './model';
import { useFlowStore } from './store';

const UNKNOWN_PREFIX = unrecognisedAccountKey('');
const EMPTY: FlowDraft = {};

export function useInboxData() {
  const { repo, now } = useInboxDeps();
  const [model, setModel] = useState<InboxModel | null>(null);
  const reload = useCallback(async () => {
    const [pending, created, rules, mappings, unread, flags, synced] = await Promise.all([
      repo.listPending('new'), repo.listPending('created'), repo.listRules(), repo.listMappings(),
      repo.getSetting(UNRECOGNISED_COUNT_KEY), repo.listSettings(UNKNOWN_PREFIX), repo.getSetting(LAST_SYNCED_KEY),
    ]);
    const queuedIds: string[] = [];
    for (const t of pending) if ((await repo.listOutbox(t.id)).some((o) => o.status === 'pending')) queuedIds.push(t.id);
    setModel(buildInboxModel({
      pending, mappings, rules, createdCount: created.length, unreadCount: Number(unread) || 0,
      unknownAccounts: flags.filter((f) => f.value !== '').map((f) => f.key.slice(UNKNOWN_PREFIX.length)),
      lastSyncedAt: synced ? Number(synced) || null : null, now: now(), queuedIds,
    }));
  }, [repo, now]);
  return { model, reload };
}

export type FlowSettingsData = { company: string; drawingsAccount: string; defaultExpense: string };
type Loaded = { txn: PendingTxn; mappings: AccountMapping[]; rules: Rule[]; settings: FlowSettingsData };

/** One txn with everything the flow screens need, and its draft answers. */
export function useTxnFlow(id: string | undefined) {
  const { repo } = useInboxDeps();
  const stored = useFlowStore((s) => (id ? s.drafts[id] : undefined)) ?? EMPTY;
  const [data, setData] = useState<Loaded | 'missing' | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      if (!id) return setData('missing');
      const txn = await repo.getPending(id);
      if (!txn) return live && setData('missing');
      const [mappings, rules, company, drawings, def] = await Promise.all([
        repo.listMappings(), repo.listRules(), repo.getSetting(COMPANY_KEY), repo.getSetting(DRAWINGS_KEY), repo.getSetting(DEFAULT_EXPENSE_KEY),
      ]);
      if (live) setData({ txn, mappings, rules, settings: { company: company ?? '', drawingsAccount: drawings ?? '', defaultExpense: def ?? '' } });
    })().catch(() => live && setData('missing'));
    return () => {
      live = false;
    };
  }, [id, repo]);
  const loaded = data && data !== 'missing' ? data : null;
  const resolved = loaded ? resolveMapping(loaded.mappings, loaded.txn) : null;
  const draft = useMemo<FlowDraft>(() => ({ ...stored, mapping: stored.mapping ?? resolved ?? undefined }), [stored, resolved]);
  const store = useFlowStore.getState;
  return {
    status: data === null ? ('loading' as const) : data === 'missing' ? ('missing' as const) : ('ready' as const),
    txn: loaded?.txn ?? null,
    mappings: loaded?.mappings ?? [],
    rules: loaded?.rules ?? [],
    settings: loaded?.settings ?? { company: '', drawingsAccount: '', defaultExpense: '' },
    /** True when the message's own account could be matched (no need to ask). */
    resolved: resolved !== null,
    draft,
    start: (d: FlowDraft) => id && store().start(id, { ...d, mapping: d.mapping ?? draft.mapping }),
    patch: (p: Partial<FlowDraft>) => id && store().patch(id, { mapping: draft.mapping, ...p }),
  };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Expo Router target for a flow step. */
export function stepHref(step: Step, id: string) {
  if (step === 'choose') return { pathname: '/txn/[id]' as const, params: { id } };
  return { pathname: `/txn/${step}` as const, params: { id } };
}

export { newestFirst };

/** Words of a counterparty worth searching ERPNext for (longest first). */
export function searchTerm(name: string | null): string | null {
  if (!name) return null;
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !/^\d+$/.test(w));
  words.sort((a, b) => b.length - a.length);
  return words[0] ?? null;
}

/**
 * Suggestions for one txn: learned rules at once, then ERPNext name matches and an exact-amount open invoice
 * of the best-matching party. Network problems only mean fewer suggestions.
 */
export function useTxnSuggestions(txn: PendingTxn | null, rules: Rule[]) {
  const { erp } = useInboxDeps();
  const [out, setOut] = useState<{ suggestions: Suggestion[]; invoiceParty?: PartyRef }>({ suggestions: [] });
  useEffect(() => {
    if (!txn) return;
    let live = true;
    setOut({ suggestions: suggest(txn, rules, [], []) });
    const term = searchTerm(txn.counterparty);
    if (!erp || !term) return;
    (async () => {
      const types: PartyRef['doctype'][] = txn.direction === 'in' ? ['Customer'] : ['Supplier', 'Employee'];
      const parties: PartyRef[] = [];
      for (const dt of types) {
        try {
          for (const p of await erp.searchParties(dt, term)) parties.push({ doctype: p.doctype, name: p.name });
        } catch {
          // no name matches this time
        }
      }
      let invoices: OpenInvoice[] = [];
      const byName = suggest(txn, [], [], parties).find((s) => s.reason === 'name_match');
      const best = byName ? ((byName.choice as { party?: PartyRef }).party ?? undefined) : undefined;
      if (best && best.doctype !== 'Employee') {
        try {
          invoices = await erp.listOpenInvoices(best.doctype as 'Customer' | 'Supplier', best.name);
        } catch {
          invoices = [];
        }
      }
      if (live) setOut({ suggestions: suggest(txn, rules, invoices, parties), invoiceParty: best });
    })();
    return () => {
      live = false;
    };
  }, [txn, rules, erp]);
  return out;
}
