import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { AUTO_ACTIONS } from '../../src/core/classify';
import { ruleChoice } from '../../src/core/suggest';
import type { ActionChoice, PartyRef, PendingTxn } from '../../src/core/types';
import { resolveMapping } from '../../src/ingest/pipeline';
import { applyToGroup, type BulkResult } from '../../src/inbox/bulk';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowLoading } from '../../src/inbox/FlowStates';
import { accountLabel, istToday, signedAmount, titleOf, whenLabel } from '../../src/inbox/format';
import { parseFilterParam, useBulkData, useDebounced, useTapGuard } from '../../src/inbox/hooks';
import { amountRange, answerText, automaticRule, bulkActions, bulkSummary, bulkTitle, groupTitle, plainFailure, planChoice, ruleHasAnswer } from '../../src/inbox/model';
import { UNKNOWN_FAILURE } from '../../src/inbox/outcome';
import { switchAutomatic } from '../../src/ingest/autoApply';
import { BackLink, Banner, Button, Card, ChoiceRow, EmptyState, Screen, Stack, TextField, Txt, confirmDialog } from '../../src/ui';

/** Item rows rendered at first and added by "Show more". */
const ITEMS_PAGE = 100;

type Stage = 'review' | 'choose' | 'account' | 'supplier';
type Done = { result: BulkResult; items: PendingTxn[]; choice: ActionChoice };

/**
 * Similar waiting payments answered together: every item listed with a tick (items that may already be booked, and
 * foreign-currency items, start unticked), the amount range, one answer for all of them, "Apply to N", an honest
 * result, and then "Do this automatically for new ... payments?". Only drafts are created, one per item.
 */
export default function BulkScreen() {
  const { key, filter: filterParam } = useLocalSearchParams<{ key: string; filter?: string }>();
  const router = useRouter();
  const deps = useInboxDeps();
  const filter = useMemo(() => parseFilterParam(filterParam), [filterParam]);
  const { data } = useBulkData(key, filter);
  const ready = data && data !== 'missing' ? data : null;
  const items = useMemo(() => ready?.items ?? [], [ready]);
  const first = items[0] ?? null;
  const tap = useTapGuard();

  const [stage, setStage] = useState<Stage>('review');
  /** The supplier step answers either "Supplier payment" or the optional supplier of an expense. */
  const [supplierFor, setSupplierFor] = useState<'payment' | 'expense'>('payment');
  const [ticked, setTicked] = useState<Set<string> | null>(null);
  const [picked, setPicked] = useState<ActionChoice | null>(null);
  const [limit, setLimit] = useState(ITEMS_PAGE);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [done, setDone] = useState<Done | null>(null);
  const [ask, setAsk] = useState(false);
  const [autoSaved, setAutoSaved] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const canTick = (t: PendingTxn) => t.currency === 'INR';
  // Ticks start once per load: all on, except a possible duplicate (warn only) and a foreign amount.
  useEffect(() => {
    if (ready && ticked === null) setTicked(new Set(ready.items.filter((t) => canTick(t) && !ready.dupIds.has(t.id)).map((t) => t.id)));
  }, [ready, ticked]);

  const allowed = useMemo(() => bulkActions(items), [items]);
  const suggested = useMemo<ActionChoice | null>(() => {
    const rule = ready?.rules.find((r) => r.matchKey === key);
    const c = rule ? ruleChoice(rule) : null;
    return c && c.type && allowed.some((a) => a.type === c.type) ? (c as ActionChoice) : null;
  }, [ready, key, allowed]);
  const choice = picked ?? suggested;

  const company = ready?.company ?? '';
  const [ledgerType, setLedgerType] = useState<'Expense' | 'Income'>('Expense');
  const ledgers = useQuery({
    queryKey: ['ledger-accounts', deps.siteUrl, company, ledgerType],
    queryFn: () => deps.erp!.listLedgerAccounts(company, { rootType: ledgerType }),
    enabled: stage === 'account' && !!deps.erp && !!company,
  });
  const who = first ? titleOf(first) : '';
  const [search, setSearch] = useState<string | null>(null);
  const term = useDebounced((search ?? who).trim(), 300);
  const suppliers = useQuery({
    queryKey: ['parties', deps.siteUrl, 'Supplier', term],
    queryFn: () => deps.erp!.searchParties('Supplier', term),
    enabled: stage === 'supplier' && !!deps.erp && term.length > 0,
  });

  if (data === null || (ready && ticked === null)) return <FlowLoading />;
  const backToInbox = () => router.dismissTo('/(tabs)/inbox');
  if (!ready || (!items.length && !done)) {
    return (
      <Screen footer={<Button label="Back to Inbox" onPress={backToInbox} />}>
        <EmptyState title="Nothing left to answer here" message="These payments may have been answered already. Your Inbox shows what still needs an answer." />
      </Screen>
    );
  }

  const tickedSet = ticked ?? new Set<string>();
  const chosenItems = items.filter((t) => tickedSet.has(t.id));
  const n = chosenItems.length;
  const range = amountRange(chosenItems);
  const dupCount = items.filter((t) => ready.dupIds.has(t.id)).length;
  const direction = first?.direction ?? 'out';
  const kind = first?.accountType ?? 'bank';

  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const pickType = (type: ActionChoice['type']) => {
    if (type === 'expense' || type === 'other_income') {
      setLedgerType(type === 'other_income' ? 'Income' : 'Expense');
      setStage('account');
      return;
    }
    if (type === 'supplier_payment') {
      setSupplierFor('payment');
      setStage('supplier');
      return;
    }
    if (type === 'personal' || type === 'ignore') {
      setPicked({ type });
      setStage('review');
    }
  };

  const apply = async () => {
    if (!choice || !n || busyRef.current) return;
    busyRef.current = true;
    try {
      if (!deps.erp) {
        router.push('/(auth)/login');
        return;
      }
      const ok = await confirmDialog({
        title: `Apply to ${n} payment${n === 1 ? '' : 's'}?`,
        message: choice.type === 'ignore'
          ? `Nothing is added to ERPNext for these ${n} messages. AutoLedger will not ask about them again.`
          : `AutoLedger creates ${n} draft${n === 1 ? '' : 's'} in ERPNext, one for each payment. Your accountant checks and submits them.`,
        confirmLabel: `Apply to ${n}`,
      });
      if (!ok) return;
      setBusy(true);
      const plan = planChoice({ mappings: ready.mappings, company: ready.company, drawingsAccount: ready.drawingsAccount, today: istToday(deps.now()) });
      let result: BulkResult;
      try {
        // The user's own answer: the rule is remembered (its largest amount may go up, as shown above).
        result = await applyToGroup({ repo: deps.repo, erp: deps.erp, runPlan: deps.runPlan, plan }, chosenItems, choice);
      } catch {
        result = { done: [], failed: chosenItems.map((t) => ({ id: t.id, message: UNKNOWN_FAILURE })), queued: [], skipped: [] };
      }
      if (!mounted.current) return;
      let alreadyAuto = false;
      try {
        const rule = (await deps.repo.listRules()).find((r) => r.matchKey === key);
        alreadyAuto = !!rule?.auto && ruleHasAnswer(rule, choice);
      } catch {
        alreadyAuto = false;
      }
      if (!mounted.current) return;
      setDone({ result, items: chosenItems, choice });
      setAsk(result.done.length > 0 && AUTO_ACTIONS.has(choice.type) && !alreadyAuto);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const makeAutomatic = async () => {
    if (!done || busyRef.current) return;
    busyRef.current = true;
    try {
      const doneIds = new Set(done.result.done);
      const rule = automaticRule(await deps.repo.listRules(), key, done.choice, done.items.filter((t) => doneIds.has(t.id)));
      // From now on only: the items just answered, and any the user left unticked, are never answered automatically.
      if (rule) await switchAutomatic(deps.repo, rule, true, deps.now());
      if (mounted.current) setAutoSaved(!!rule);
    } catch {
      // the rule stays manual; nothing else changes
    } finally {
      busyRef.current = false;
      if (mounted.current) setAsk(false);
    }
  };

  if (done) {
    const { result } = done;
    const byId = new Map(done.items.map((t) => [t.id, t]));
    const allOk = result.failed.length === 0 && result.queued.length === 0;
    return (
      <Screen title={groupTitle(done.items)} footer={<Button label="Back to Inbox" variant={ask ? 'secondary' : 'primary'} onPress={backToInbox} />}>
        <Banner tone={allOk ? 'ok' : 'warn'} title={bulkTitle(result)} message={bulkSummary(result)} testID="bulk-result" />
        {result.queued.length ? (
          <Banner tone="info" message="No connection for some of them. Those answers are saved and will be sent when you are back online." />
        ) : null}
        {result.failed.length ? (
          <Card title="These need your attention">
            <Txt variant="muted">They stay in your Inbox. Open each one to answer it.</Txt>
            {result.failed.map((f) => {
              const t = byId.get(f.id);
              return (
                <View key={f.id} testID={`failure-${f.id}`} className="mt-3">
                  <Txt variant="strong">{t ? `${signedAmount(t)}, ${whenLabel(t, istToday(deps.now()))}` : 'A payment'}</Txt>
                  <Txt variant="body">{plainFailure(f.message)}</Txt>
                </View>
              );
            })}
          </Card>
        ) : null}
        {ask ? (
          <View testID="ask-auto">
            <Card title={`Do this automatically for new ${titleOf(done.items[0])} payments?`}>
              <Txt variant="body">
                {`AutoLedger will answer new ones as ${answerText(done.choice, direction, kind)} after each check, as drafts only. It never does this for a payment that may already be in ERPNext or that is much larger than these. You can turn it off in Settings.`}
              </Txt>
              <Stack gap={2}>
                <View className="mt-3">
                  <Button label="Yes, do this automatically" onPress={() => void makeAutomatic()} testID="auto-yes" />
                </View>
                <Button variant="quiet" label="Not now" onPress={() => setAsk(false)} testID="auto-no" />
              </Stack>
            </Card>
          </View>
        ) : null}
        {autoSaved ? (
          <Banner tone="ok" message={`New ${titleOf(done.items[0])} payments will be answered automatically. You can turn this off in Settings, under Automatic rules.`} testID="auto-saved" />
        ) : null}
      </Screen>
    );
  }

  if (stage === 'choose') {
    return (
      <Screen top={<BackLink label="Back" onPress={() => setStage('review')} />} title="What were these payments?" subtitle="One answer for every ticked payment.">
        {allowed.map((a) => {
          const noDrawings = a.type === 'personal' && !ready.drawingsAccount;
          return (
            <ChoiceRow
              key={a.type}
              title={a.label}
              subtitle={noDrawings ? 'Set your Drawings account in Settings first (Run setup again).' : a.hint}
              selected={choice?.type === a.type}
              disabled={noDrawings}
              onPress={() => pickType(a.type)}
            />
          );
        })}
        <Txt variant="muted">Other answers, like salary or a payment against a bill, are given one payment at a time.</Txt>
      </Screen>
    );
  }

  if (stage === 'account') {
    const income = ledgerType === 'Income';
    return (
      <Screen
        top={<BackLink label="Back" onPress={() => setStage('choose')} />}
        title={income ? 'Which income account?' : 'Which expense account?'}
        subtitle={income ? 'Where this income is booked in ERPNext.' : 'Where this cost is booked in ERPNext.'}>
        {!deps.erp ? <Banner tone="warn" message="You are signed out of ERPNext. Sign in again to choose an account." /> : null}
        {!company ? <Banner tone="error" message="Choose your company in Settings first." /> : null}
        {ledgers.isLoading ? <Banner message="Loading accounts..." /> : null}
        {ledgers.isError ? <Banner tone="error" message="Could not load the accounts. Check your connection." actionLabel="Try again" onAction={() => ledgers.refetch()} /> : null}
        {(ledgers.data ?? []).map((a) => (
          <ChoiceRow
            key={a.name}
            title={a.name}
            selected={(choice?.type === 'expense' && choice.expenseAccount === a.name) || (choice?.type === 'other_income' && choice.incomeAccount === a.name)}
            onPress={() => {
              const party = choice?.type === 'expense' ? choice.party : undefined;
              setPicked(income ? { type: 'other_income', incomeAccount: a.name } : party ? { type: 'expense', expenseAccount: a.name, party } : { type: 'expense', expenseAccount: a.name });
              setStage('review');
            }}
          />
        ))}
      </Screen>
    );
  }

  if (stage === 'supplier') {
    return (
      <Screen
        top={<BackLink label="Back" onPress={() => setStage(supplierFor === 'expense' ? 'review' : 'choose')} />}
        title={supplierFor === 'expense' ? 'Which supplier was this expense for?' : 'Which supplier?'}
        subtitle={`The bank message says: ${who}`}>
        {!deps.erp ? <Banner tone="warn" message="You are signed out of ERPNext. Sign in again to search." /> : null}
        <TextField label="Search suppliers" value={search ?? who} onChangeText={setSearch} autoCapitalize="none" autoCorrect={false} placeholder="Name" />
        {suppliers.isError ? <Banner tone="error" message="Could not search ERPNext. Check your connection and try again." actionLabel="Try again" onAction={() => suppliers.refetch()} /> : null}
        {suppliers.isFetching ? <Txt variant="muted">Searching...</Txt> : null}
        {suppliers.data && suppliers.data.length === 0 && !suppliers.isFetching ? <Txt variant="muted">{`No supplier matches "${term}".`}</Txt> : null}
        <Txt variant="muted">Only suppliers already in ERPNext can be chosen here. Add a new supplier in ERPNext first, then come back.</Txt>
        {(suppliers.data ?? []).map((p) => (
          <ChoiceRow
            key={p.name}
            title={p.displayName}
            subtitle={p.displayName !== p.name ? p.name : undefined}
            selected={(choice?.type === 'supplier_payment' || choice?.type === 'expense') && choice.party?.name === p.name}
            onPress={() => {
              const party: PartyRef = { doctype: p.doctype, name: p.name };
              if (supplierFor === 'expense' && choice?.type === 'expense') setPicked({ ...choice, party });
              else setPicked({ type: 'supplier_payment', party });
              setStage('review');
            }}
          />
        ))}
      </Screen>
    );
  }

  const today = istToday(deps.now());
  return (
    <Screen
      top={<BackLink label="Inbox" disabled={busy} onPress={() => router.back()} />}
      title={groupTitle(items)}
      subtitle="Choose one answer for the ticked payments. Untick any that were for something else."
      footer={<Button label={`Apply to ${n}`} onPress={() => void apply()} loading={busy} disabled={!choice || n === 0 || busy} testID="apply" />}>
      <Card title="Answer for the ticked payments">
        <View testID="bulk-answer">
          <Txt variant="strong">{choice ? answerText(choice, direction, kind) : 'Not chosen yet'}</Txt>
        </View>
        <View className="mt-2">
          <Button variant="secondary" label={choice ? 'Change the answer' : 'Choose the answer'} disabled={busy} onPress={() => tap(() => setStage('choose'))} />
        </View>
        {choice?.type === 'expense' ? (
          choice.party ? (
            <Button
              variant="quiet" label="Remove supplier" disabled={busy}
              onPress={() => setPicked({ type: 'expense', expenseAccount: choice.expenseAccount })} />
          ) : (
            <Button
              variant="quiet" label="Link a supplier (optional)" disabled={busy}
              onPress={() => { setSupplierFor('expense'); setStage('supplier'); }} />
          )
        ) : null}
      </Card>
      {busy ? <Banner tone="info" message={`Sending ${n} answers to ERPNext, one at a time. Stay on this screen until it finishes.`} testID="bulk-sending" /> : null}
      {range ? (
        <View testID="bulk-range" className="mb-3">
          <Txt variant="body">{range.includes(' to ') ? `Amounts from ${range}` : `Amount ${range}`}</Txt>
          <Txt variant="muted">AutoLedger remembers the largest amount. Automatic answers never go above twice that.</Txt>
        </View>
      ) : null}
      {dupCount ? (
        <Banner
          tone="warn"
          testID="bulk-dups"
          message={dupCount === 1
            ? '1 payment may already be in ERPNext, so it is not ticked. Check it before ticking it.'
            : `${dupCount} payments may already be in ERPNext, so they are not ticked. Check them before ticking them.`}
        />
      ) : null}
      <Txt variant="section" header>{`${n} of ${items.length} ticked`}</Txt>
      <View className="mt-2">
        {items.slice(0, limit).map((t) => {
          const dup = ready.dupIds.has(t.id);
          const foreign = !canTick(t);
          const note = foreign ? 'Needs the rupee amount. Answer it on its own.' : dup ? 'May already be in ERPNext' : null;
          return (
            <ChoiceRow
              key={t.id}
              testID={`item-${t.id}`}
              role="checkbox"
              title={signedAmount(t)}
              subtitle={[whenLabel(t, today), accountLabel(t, resolveMapping(ready.mappings, t)), note].filter(Boolean).join(' · ')}
              selected={tickedSet.has(t.id)}
              disabled={foreign || busy}
              onPress={() => toggle(t.id)}
            />
          );
        })}
      </View>
      {items.length > limit ? <Button variant="quiet" label={`Show ${Math.min(ITEMS_PAGE, items.length - limit)} more`} onPress={() => setLimit((l) => l + ITEMS_PAGE)} /> : null}
    </Screen>
  );
}
