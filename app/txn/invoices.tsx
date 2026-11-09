import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { nextStep } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { defaultAllocation, effectiveAmountMinor, parseRupees, toPaise, validateAllocations, type InvoicePick } from '../../src/inbox/flow';
import { longDate } from '../../src/inbox/format';
import { stepHref, useTxnFlow } from '../../src/inbox/hooks';
import { BackLink, Banner, Button, ChoiceRow, EmptyState, Screen, TextField, Txt, formatInr } from '../../src/ui';

export default function InvoicesStep() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { erp, siteUrl } = useInboxDeps();
  const f = useTxnFlow(id);
  const txn = f.txn;
  const party = f.draft.party;
  const partyType = txn?.direction === 'in' ? 'Customer' : 'Supplier';
  const single = f.draft.action === 'bill_paid_by_card';
  // name -> rupee text as typed
  const [picks, setPicks] = useState<Record<string, string> | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof validateAllocations> | null>(null);

  const q = useQuery({
    queryKey: ['open-invoices', siteUrl, partyType, party?.name],
    queryFn: () => erp!.listOpenInvoices(partyType, party!.name),
    enabled: !!erp && !!party && !f.draft.newParty,
  });

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !txn || !party) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const wanted = txn.direction === 'in' ? 'Sales Invoice' : 'Purchase Invoice';
  const amount = effectiveAmountMinor(txn, f.draft) ?? 0;
  const invoices = (q.data ?? []).filter((i) => i.doctype === wanted);
  const chosen: Record<string, string> = picks ?? Object.fromEntries((f.draft.invoices ?? []).map((i) => [i.name, toPaise(i.allocatedMinor)]));
  const word = txn.direction === 'in' ? 'invoice' : 'bill';
  const who = party.displayName ?? party.name;

  const toggle = (name: string, outstanding: number) => {
    setCheck(null);
    const next = single ? {} : { ...chosen };
    if (chosen[name] !== undefined) {
      delete next[name];
    } else {
      const others = Object.values(next).map((t) => parseRupees(t) ?? 0);
      next[name] = toPaise(defaultAllocation(amount, outstanding, others));
    }
    setPicks(next);
  };

  const onContinue = () => {
    const rows = invoices
      .filter((i) => chosen[i.name] !== undefined)
      .map((i) => ({ name: i.name, outstandingMinor: i.outstandingMinor, allocatedMinor: parseRupees(chosen[i.name]) ?? 0 }));
    const c = validateAllocations(amount, rows);
    setCheck(c);
    if (!c.ok) return;
    const picked: InvoicePick[] = rows.map((r) => ({ doctype: wanted, name: r.name, allocatedMinor: r.allocatedMinor }));
    f.patch({ invoices: picked });
    router.push(stepHref(nextStep(txn, { ...f.draft, invoices: picked }), txn.id));
  };

  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title={single ? `Which ${word} did the card pay?` : `Which ${word}s does this pay?`}
      subtitle={`Open ${word}s of ${who}. This payment is ${formatInr(amount)}; you can pay part of a ${word}.`}
      footer={<Button label="Continue" onPress={onContinue} disabled={!q.data} />}>
      {q.isLoading ? <Banner message={`Loading open ${word}s...`} /> : null}
      {q.isError ? <Banner tone="error" message={`Could not load the open ${word}s. Check your connection.`} actionLabel="Try again" onAction={() => q.refetch()} /> : null}
      {q.data && invoices.length === 0 ? (
        <EmptyState title={`No open ${word}s`} message={`${who} has no unpaid ${word}s in ERPNext. Go back and choose ${txn.direction === 'in' ? 'Customer advance' : 'another answer'} instead.`} />
      ) : null}
      {check?.total ? <Banner tone="error" message={check.total} /> : null}
      {invoices.map((i) => {
        const on = chosen[i.name] !== undefined;
        return (
          <ChoiceRow
            key={i.name}
            role={single ? 'radio' : 'checkbox'}
            title={i.name}
            subtitle={`${formatInr(i.outstandingMinor)} still due${i.dueDate ? `, due ${longDate(i.dueDate)}` : ''}`}
            selected={on}
            onPress={() => toggle(i.name, i.outstandingMinor)}
          />
        );
      })}
      {invoices.filter((i) => chosen[i.name] !== undefined).map((i) => (
        <TextField
          key={`amt-${i.name}`}
          label={`Amount for ${i.name} (₹)`}
          value={chosen[i.name]}
          keyboardType="decimal-pad"
          onChangeText={(t) => {
            setCheck(null);
            setPicks({ ...chosen, [i.name]: t });
          }}
          error={check?.errors[i.name]}
        />
      ))}
      {Object.keys(chosen).length > 0 ? (
        <Txt variant="muted">{`Total: ${formatInr(Object.values(chosen).reduce((s, t) => s + (parseRupees(t) ?? 0), 0))} of ${formatInr(amount)}`}</Txt>
      ) : null}
    </Screen>
  );
}
