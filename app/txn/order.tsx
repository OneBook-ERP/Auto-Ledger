import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { listOpenSalesOrders } from '../../src/erp/docs';
import { nextStep } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { chooseOrders, defaultAllocation, effectiveAmountMinor, parseRupees, skipOrders, toPaise } from '../../src/inbox/flow';
import { longDate } from '../../src/inbox/format';
import { stepHref, useTxnFlow } from '../../src/inbox/hooks';
import { useApp } from '../../src/state/AppProvider';
import { BackLink, Banner, Button, ChoiceRow, Screen, Stack, TextField, Txt, formatInr } from '../../src/ui';

/** Customer advance: which open Sales Order(s) the money is for, or none (a plain advance). */
export default function OrderStep() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { siteUrl } = useInboxDeps();
  const { client } = useApp();
  const f = useTxnFlow(id);
  const txn = f.txn;
  const party = f.draft.party;
  // name -> rupee text as typed
  const [picks, setPicks] = useState<Record<string, string> | null>(null);
  const [check, setCheck] = useState<ReturnType<typeof chooseOrders>['check'] | null>(null);

  const q = useQuery({
    queryKey: ['open-orders', siteUrl, party?.name],
    queryFn: () => listOpenSalesOrders(client!, party!.name),
    enabled: !!client && !!party && !f.draft.newParty,
  });

  // No open orders (or a new customer): nothing to ask, go straight on as a plain advance.
  const nothingToAsk = !!txn && txn.state === 'new' && !!party && (!!f.draft.newParty || (!!q.data && q.data.length === 0));
  useEffect(() => {
    if (!nothingToAsk || !txn) return;
    f.patch(skipOrders());
    router.replace(stepHref(nextStep(txn, { ...f.draft, ...skipOrders() }), txn.id));
  }, [nothingToAsk]); // once, when it becomes clear there is nothing to ask

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !txn || !party) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const amount = effectiveAmountMinor(txn, f.draft) ?? 0;
  const orders = q.data ?? [];
  const chosen: Record<string, string> = picks ?? Object.fromEntries((f.draft.orders ?? []).map((o) => [o.name, toPaise(o.allocatedMinor)]));
  const who = party.displayName ?? party.name;

  const go = (patch: ReturnType<typeof skipOrders>) => {
    f.patch(patch);
    router.push(stepHref(nextStep(txn, { ...f.draft, ...patch }), txn.id));
  };

  const toggle = (name: string, remaining: number) => {
    setCheck(null);
    const next = { ...chosen };
    if (chosen[name] !== undefined) {
      delete next[name];
    } else {
      const others = Object.values(next).map((t) => parseRupees(t) ?? 0);
      next[name] = toPaise(defaultAllocation(amount, remaining, others));
    }
    setPicks(next);
  };

  const onContinue = () => {
    const rows = orders
      .filter((o) => chosen[o.name] !== undefined)
      .map((o) => ({ name: o.name, remainingMinor: o.remainingMinor, allocatedMinor: parseRupees(chosen[o.name]) ?? 0 }));
    const r = chooseOrders(amount, rows);
    setCheck(r.check);
    if (r.patch) go(r.patch);
  };

  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title="Which order is this for?"
      subtitle={`Open orders of ${who}. This payment is ${formatInr(amount)}; it can pay part of an order.`}
      footer={
        <Stack gap={2}>
          <Button label="Continue" onPress={onContinue} disabled={!q.data || orders.length === 0} />
          <Button variant="secondary" label="Skip, this is not for an order" onPress={() => go(skipOrders())} />
        </Stack>
      }>
      {!client ? <Banner tone="warn" message="You are signed out of ERPNext. Sign in again to see the orders, or skip this step." /> : null}
      {q.isLoading ? <Banner message="Loading open orders..." /> : null}
      {q.isError ? <Banner tone="error" message="Could not load the open orders. Check your connection." actionLabel="Try again" onAction={() => q.refetch()} /> : null}
      {check?.total ? <Banner tone="error" message={check.total} /> : null}
      {orders.map((o) => (
        <ChoiceRow
          key={o.name}
          role="checkbox"
          title={o.name}
          subtitle={[
            `Order total ${formatInr(o.totalMinor)}`,
            `already paid ${formatInr(o.advanceMinor)}`,
            `left to pay ${formatInr(o.remainingMinor)}`,
          ].join(', ') + (o.deliveryDate ? `. Delivery by ${longDate(o.deliveryDate)}` : '')}
          selected={chosen[o.name] !== undefined}
          onPress={() => toggle(o.name, o.remainingMinor)}
        />
      ))}
      {orders.filter((o) => chosen[o.name] !== undefined).map((o) => (
        <TextField
          key={`amt-${o.name}`}
          label={`Amount for ${o.name} (₹)`}
          value={chosen[o.name]}
          keyboardType="decimal-pad"
          onChangeText={(t) => {
            setCheck(null);
            setPicks({ ...chosen, [o.name]: t });
          }}
          error={check?.errors[o.name]}
        />
      ))}
      {Object.keys(chosen).length > 0 ? (
        <Txt variant="muted">{`Total: ${formatInr(Object.values(chosen).reduce((s, t) => s + (parseRupees(t) ?? 0), 0))} of ${formatInr(amount)}`}</Txt>
      ) : null}
    </Screen>
  );
}
