import { useLocalSearchParams, useRouter } from 'expo-router';
import { txnReference } from '../../src/core/plan';
import { actionsFor, nextStep, type ActionType } from '../../src/inbox/actions';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import type { FlowDraft } from '../../src/inbox/flow';
import { accountLabel, amountA11y, dateTimeLabel, kindLabel, plainAmount, shortAccount } from '../../src/inbox/format';
import { stepHref, useTapGuard, useTxnFlow, useTxnSuggestions } from '../../src/inbox/hooks';
import { useFlowStore } from '../../src/inbox/store';
import { draftFromSuggestion, suggestionCard, usableSuggestions } from '../../src/inbox/suggestions';
import { ActionSheet, BackLink, Banner, ChoiceRow, DetailCard, Gap, Screen, Stack, SuggestionCard, Txt, type Detail } from '../../src/ui';

export const DRAWINGS_MISSING = 'Set your Drawings account first';

export default function TransactionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const f = useTxnFlow(id);
  const { suggestions, invoiceParty } = useTxnSuggestions(f.txn, f.rules);
  const tap = useTapGuard();
  const sending = useFlowStore((st) => (id ? !!st.sending[id] : false));
  const toInbox = () => router.navigate('/(tabs)/inbox');

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !f.txn) return <FlowGone onInbox={toInbox} />;
  const txn = f.txn;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={toInbox} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const incoming = txn.direction === 'in';
  const mapping = f.draft.mapping ?? null;
  const hasDrawings = !!f.settings.drawingsAccount;
  const candidates = f.mappings.filter((m) => m.kind === txn.accountType);
  const top = mapping ? usableSuggestions(txn, suggestions, { drawings: hasDrawings })[0] : undefined;

  const go = (d: FlowDraft) =>
    tap(() => {
      f.start(d);
      router.push(stepHref(nextStep(txn, d), txn.id));
    });
  const choose = (type: string) => {
    const t = type as ActionType;
    const d: FlowDraft = { mapping: mapping ?? undefined, action: t };
    if (t === 'expense') {
      const ruled = top?.choice.type === 'expense' ? (top.choice as { expenseAccount?: string }).expenseAccount : undefined;
      d.suggestedAccount = ruled ?? (f.settings.defaultExpense || undefined);
    }
    go(d);
  };

  const who = txn.counterparty ?? txn.merchant;
  const ref = txnReference(txn);
  const rows: Detail[] = [];
  if (who) rows.push({ label: incoming ? 'From' : txn.merchant && !txn.counterparty ? 'Merchant' : 'To', value: who });
  rows.push({ label: incoming ? 'Into' : 'From account', value: accountLabel(txn, mapping) });
  const more: Detail[] = [{ label: 'Reference', value: ref, mono: true }];
  if (txn.mergedCount > 1) more.push({ label: 'Bank messages', value: `Confirmed by ${txn.mergedCount} bank messages` });
  if (txn.sender) more.push({ label: 'Sender', value: txn.sender });

  const items = actionsFor(txn.direction, txn.accountType).map((a) => ({
    key: a.type,
    label: a.label,
    hint: a.hint,
    disabled: sending || f.rereading || (a.type === 'personal' && !hasDrawings),
    disabledReason: a.type === 'personal' && !hasDrawings ? DRAWINGS_MISSING : undefined,
    action: a.type === 'personal' && !hasDrawings ? { label: 'Open Settings', onPress: () => router.navigate('/(tabs)/settings') } : undefined,
  }));
  // Ignore needs no account: it is offered even while the account is unknown.
  const ignoreOnly = items.filter((a) => a.key === 'ignore');
  const pickerText = txn.accountLast4
    ? `No saved ${txn.accountType === 'card' ? 'card' : 'account'} ends in ${txn.accountLast4} any more. Choose the one this message belongs to.`
    : `The message does not say which of your ${txn.accountType === 'card' ? 'cards' : 'bank accounts'} this was. Choose one.`;

  return (
    <Screen top={<BackLink label="Inbox" onPress={() => (router.canGoBack() ? router.back() : toInbox())} />}>
      <Stack gap={1}>
        <Txt variant={incoming ? 'in' : 'out'}>{incoming ? 'Money received' : 'Money paid'}</Txt>
        <Txt variant="hero" header a11yLabel={amountA11y(txn)}>{plainAmount(txn)}</Txt>
        <Txt variant="muted">{`${dateTimeLabel(txn)} · ${kindLabel(txn.kind)}`}</Txt>
      </Stack>
      <Gap size={4} />
      <DetailCard rows={rows} more={more} />
      {sending ? <Banner tone="info" message="Still sending your previous answer. Wait for it to finish." testID="sending" /> : null}
      {txn.error ? <Banner tone="error" title="The last attempt did not work" message={txn.error} /> : null}

      {!f.resolved ? (
        <>
          <Txt variant="heading" header>Which account is this?</Txt>
          <Txt variant="muted">{pickerText}</Txt>
          <Gap size={3} />
          <Stack gap={1}>
            {candidates.map((m) => (
              <ChoiceRow
                key={m.bankAccount}
                title={shortAccount(m.bankAccount)}
                subtitle={`Ending ${m.last4.join(', ')}`}
                selected={mapping?.bankAccount === m.bankAccount}
                onPress={() => f.start({ mapping: m })}
              />
            ))}
          </Stack>
          {candidates.length === 0 ? (
            <Banner tone="warn" title="No matching account" message={`No ${txn.accountType === 'card' ? 'card' : 'bank account'} is set up in AutoLedger. Run setup again in Settings to add it.`} actionLabel="Open Settings" onAction={() => router.navigate('/(tabs)/settings')} />
          ) : null}
          {!mapping ? (
            <>
              <Txt variant="muted">Or, if this message is not a business transaction:</Txt>
              <Gap size={2} />
              <ActionSheet items={ignoreOnly} onSelect={choose} />
            </>
          ) : null}
        </>
      ) : null}

      {mapping ? (
        <>
          <Txt variant="heading" header>What was this?</Txt>
          <Gap size={3} />
          {top ? (
            <SuggestionCard {...suggestionCard(top, invoiceParty)} onPress={() => !sending && !f.rereading && go({ mapping, ...draftFromSuggestion(top, invoiceParty) })} />
          ) : null}
          <ActionSheet items={items} onSelect={choose} />
        </>
      ) : null}
    </Screen>
  );
}
