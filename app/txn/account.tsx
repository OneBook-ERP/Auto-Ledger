import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { nextStep } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { shortAccount } from '../../src/inbox/format';
import { stepHref, useTxnFlow } from '../../src/inbox/hooks';
import { BackLink, Banner, Button, ChoiceRow, Screen, TextField, Txt } from '../../src/ui';

export default function AccountStep() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { erp, siteUrl } = useInboxDeps();
  const f = useTxnFlow(id);
  const txn = f.txn;
  const action = f.draft.action;
  const ledger = action === 'expense' || action === 'other_income';
  const rootType = action === 'other_income' ? 'Income' : 'Expense';
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const transferIn = action === 'transfer' && txn?.direction === 'in';
  const banks = useQuery({
    queryKey: ['bank-accounts', siteUrl, f.settings.company],
    queryFn: () => erp!.listBankAccounts(f.settings.company),
    enabled: !!erp && transferIn && !!f.settings.company,
  });
  const q = useQuery({
    queryKey: ['ledger-accounts', siteUrl, f.settings.company, rootType],
    queryFn: () => erp!.listLedgerAccounts(f.settings.company, { rootType }),
    enabled: !!erp && ledger && !!f.settings.company,
  });

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !txn || !action) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const mapping = f.draft.mapping;
  const go = (patch: Parameters<typeof f.patch>[0]) => {
    f.patch(patch);
    router.push(stepHref(nextStep(txn, { ...f.draft, ...patch }), txn.id));
  };

  if (action === 'transfer' && txn.direction === 'in') {
    // Any of the company's ERPNext Bank Accounts can be the source, read by AutoLedger or not (R52b).
    const sources = (banks.data ?? []).filter((b) => b.isCompanyAccount && b.name !== mapping?.bankAccount && b.glAccount !== mapping?.glAccount);
    const chosen = picked ?? f.draft.fromAccount?.bankAccount ?? null;
    const readBy = (name: string) => f.mappings.find((m) => m.bankAccount === name);
    return (
      <Screen
        top={<BackLink label="Back" onPress={() => router.back()} />}
        title="Which account did the money come from?"
        subtitle="Your bank accounts in ERPNext. The transfer is booked from that account into this one."
        footer={<Button label="Continue" disabled={!banks.data} onPress={() => {
          const b = sources.find((x) => x.name === chosen);
          if (!b) return setMissing(true);
          const m = readBy(b.name);
          go({ fromAccount: m ? { bankAccount: b.name, glAccount: b.glAccount, modeOfPayment: m.modeOfPayment } : { bankAccount: b.name, glAccount: b.glAccount } });
        }} />}>
        {!f.settings.company ? <Banner tone="error" message="Choose your company in Settings first (Run setup again)." /> : null}
        {missing ? <Banner tone="error" message="Choose the account the money came from." /> : null}
        {banks.isLoading ? <Banner message="Loading your bank accounts..." /> : null}
        {banks.isError ? <Banner tone="error" message="Could not load your bank accounts. Check your connection." actionLabel="Try again" onAction={() => banks.refetch()} /> : null}
        {banks.data && sources.length === 0 ? (
          <Banner tone="warn" title="No other bank account" message="ERPNext has no other bank account for this company. Add it as a Bank Account in ERPNext first." />
        ) : null}
        {sources.map((b) => (
          <ChoiceRow key={b.name} title={shortAccount(b.name)} subtitle={readBy(b.name) ? `${b.glAccount}. AutoLedger reads its messages.` : b.glAccount}
            selected={chosen === b.name} onPress={() => { setPicked(b.name); setMissing(false); }} />
        ))}
      </Screen>
    );
  }

  if (action === 'transfer') {
    const others = f.mappings.filter((m) => m.glAccount !== mapping?.glAccount);
    const chosen = picked ?? f.draft.toAccount?.bankAccount ?? null;
    return (
      <Screen
        top={<BackLink label="Back" onPress={() => router.back()} />}
        title="Which account did the money go to?"
        subtitle="For a credit card bill paid from this account, choose the card."
        footer={<Button label="Continue" onPress={() => {
          const m = others.find((x) => x.bankAccount === chosen);
          if (!m) return setMissing(true);
          go({ toAccount: m });
        }} />}>
        {missing ? <Banner tone="error" message="Choose the account the money went to." /> : null}
        {others.length === 0 ? (
          <Banner tone="warn" title="No other account" message="Only one account is set up in AutoLedger. Run setup again in Settings to add the other one." />
        ) : null}
        {others.map((m) => (
          <ChoiceRow key={m.bankAccount} title={shortAccount(m.bankAccount)} subtitle={`${m.kind === 'card' ? 'Card' : 'Bank account'}, ending ${m.last4.join(', ')}`}
            selected={chosen === m.bankAccount} onPress={() => { setPicked(m.bankAccount); setMissing(false); }} />
        ))}
      </Screen>
    );
  }

  const chosen = picked ?? f.draft.account ?? f.draft.suggestedAccount ?? null;
  const all = q.data ?? [];
  const needle = filter.trim().toLowerCase();
  const shown = needle ? all.filter((a) => a.name.toLowerCase().includes(needle)) : all;
  const isExpense = action === 'expense';
  const supplier = isExpense ? f.draft.party : undefined;

  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title={isExpense ? 'Which expense account?' : 'Which income account?'}
      subtitle={isExpense ? 'Where this cost is booked in ERPNext.' : 'Where this income is booked in ERPNext.'}
      footer={<Button label="Continue" onPress={() => {
        if (!chosen || (q.data && !all.some((a) => a.name === chosen))) return setMissing(true);
        go({ account: chosen });
      }} />}>
      {!f.settings.company ? <Banner tone="error" message="Choose your company in Settings first (Run setup again)." /> : null}
      {missing ? <Banner tone="error" message="Choose an account from the list." /> : null}
      {q.isLoading ? <Banner message="Loading accounts..." /> : null}
      {q.isError ? <Banner tone="error" message="Could not load the accounts. Check your connection." actionLabel="Try again" onAction={() => q.refetch()} /> : null}
      {isExpense ? (
        <>
          {supplier ? (
            <Banner tone="info" message={`For supplier ${supplier.displayName ?? supplier.name}.`} actionLabel="Remove supplier" onAction={() => f.patch({ party: undefined, newParty: undefined })} />
          ) : (
            <Button variant="quiet" label="Link a supplier (optional)" onPress={() => router.push({ pathname: '/txn/party', params: { id: txn.id, optional: '1' } })} />
          )}
        </>
      ) : null}
      {all.length > 8 ? <TextField label="Filter accounts" value={filter} onChangeText={setFilter} autoCapitalize="none" autoCorrect={false} /> : null}
      {q.data && shown.length === 0 ? <Txt variant="muted">No account matches.</Txt> : null}
      {shown.map((a) => (
        <ChoiceRow key={a.name} title={a.name} selected={chosen === a.name} onPress={() => { setPicked(a.name); setMissing(false); }} />
      ))}
    </Screen>
  );
}
