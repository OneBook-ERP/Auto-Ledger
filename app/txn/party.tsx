import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { nextStep, partyDoctypeFor } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { buildNewParty, extraFields, validateNewParty } from '../../src/inbox/flow';
import { stepHref, useDebounced, useTxnFlow } from '../../src/inbox/hooks';
import { BackLink, Banner, Button, ChoiceRow, Gap, Screen, Stack, TextField, Txt } from '../../src/ui';

const PERSON: Record<string, string> = { Customer: 'customer', Supplier: 'supplier', Employee: 'employee' };

export default function PartyStep() {
  const { id, optional } = useLocalSearchParams<{ id: string; optional?: string }>();
  const router = useRouter();
  const { erp, siteUrl } = useInboxDeps();
  const f = useTxnFlow(id);
  const txn = f.txn;
  const doctype = txn && f.draft.action ? partyDoctypeFor(f.draft.action, txn.direction) : null;
  const who = txn ? (txn.counterparty ?? txn.merchant ?? '') : '';
  const [query, setQuery] = useState<string | null>(null);
  const q = useDebounced((query ?? who).trim(), 300);
  const [picked, setPicked] = useState<{ doctype: 'Customer' | 'Supplier' | 'Employee'; name: string; displayName: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [needPick, setNeedPick] = useState(false);

  const results = useQuery({
    queryKey: ['parties', siteUrl, doctype, q],
    queryFn: () => erp!.searchParties(doctype!, q),
    enabled: !!erp && !!doctype && q.length > 0 && !creating,
  });
  const required = useQuery({
    queryKey: ['required-fields', siteUrl, doctype],
    queryFn: () => erp!.getRequiredFields(doctype!),
    enabled: !!erp && !!doctype && creating,
  });

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !txn || !doctype) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const person = PERSON[doctype];
  const invoiceFlow = f.draft.action === 'against_invoice' || f.draft.action === 'bill_paid_by_card';
  const current = picked ?? (f.draft.party && !f.draft.newParty ? { ...f.draft.party, displayName: f.draft.party.displayName ?? f.draft.party.name } : null);
  const fields = extraFields(required.data ?? []);
  const newName = name ?? f.draft.newParty?.ref.name ?? who;

  const proceed = (patch: Parameters<typeof f.patch>[0]) => {
    f.patch(patch);
    if (optional) return router.back();
    router.push(stepHref(nextStep(txn, { ...f.draft, ...patch }), txn.id));
  };

  const onContinue = () => {
    if (creating) {
      const errs = validateNewParty(newName, extra, required.data ?? []);
      setErrors(errs);
      if (Object.keys(errs).length) return;
      const np = buildNewParty(doctype, newName, extra, required.data ?? []);
      proceed({ party: np.ref, newParty: np, invoices: undefined, orders: undefined });
      return;
    }
    if (!current) return setNeedPick(true);
    proceed({ party: { doctype: current.doctype, name: current.name, displayName: current.displayName }, newParty: undefined, invoices: undefined, orders: undefined });
  };

  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title={doctype === 'Employee' ? 'Which employee?' : `Which ${person}?`}
      subtitle={who ? `The bank message says: ${who}` : 'The bank message does not name anyone.'}
      footer={<Button label="Continue" onPress={onContinue} />}>
      {!erp ? <Banner tone="warn" message="You are signed out of ERPNext. Sign in again to search." /> : null}
      {creating ? (
        <>
          <Txt variant="heading" header>{`New ${person}`}</Txt>
          <Gap size={3} />
          <TextField
            label={doctype === 'Employee' ? 'Employee name' : `${doctype} name`}
            value={newName}
            onChangeText={(t) => setName(t)}
            error={errors.name}
            hint="As it should appear in ERPNext."
            autoCapitalize="words"
          />
          {required.isError ? (
            <Banner tone="warn" message="Could not check which other details ERPNext needs. You can continue; if ERPNext asks for more, you will see what is missing." />
          ) : null}
          {required.isLoading ? <Txt variant="muted">Checking what ERPNext needs...</Txt> : null}
          {fields.map((fd) => (
            <TextField
              key={fd.fieldname}
              label={fd.label}
              value={extra[fd.fieldname] ?? ''}
              onChangeText={(t) => setExtra((x) => ({ ...x, [fd.fieldname]: t }))}
              error={errors[fd.fieldname]}
              hint={fd.fieldtype === 'Date' ? 'YYYY-MM-DD' : fd.fieldtype === 'Link' || fd.fieldtype === 'Select' ? 'Type it exactly as in ERPNext.' : 'ERPNext needs this.'}
              autoCapitalize="none"
            />
          ))}
          <Button variant="quiet" label="Search existing instead" onPress={() => setCreating(false)} />
        </>
      ) : (
        <>
          <TextField
            label={`Search ${person}s`}
            value={query ?? who}
            onChangeText={(t) => setQuery(t)}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Name"
          />
          {needPick && !current ? <Banner tone="error" message={`Choose a ${person} from the list, or create a new one.`} /> : null}
          {results.isError ? <Banner tone="error" message="Could not search ERPNext. Check your connection and try again." actionLabel="Try again" onAction={() => results.refetch()} /> : null}
          {results.isFetching ? <Txt variant="muted">Searching...</Txt> : null}
          {results.data && results.data.length === 0 && !results.isFetching ? <Txt variant="muted">{`No ${person} matches "${q}".`}</Txt> : null}
          <Stack gap={1}>
            {(results.data ?? []).map((p) => (
              <ChoiceRow
                key={p.name}
                title={p.displayName}
                subtitle={p.displayName !== p.name ? p.name : undefined}
                selected={current?.name === p.name && current.doctype === p.doctype}
                onPress={() => {
                  setPicked(p);
                  setNeedPick(false);
                }}
              />
            ))}
          </Stack>
          <Gap size={3} />
          {invoiceFlow ? (
            <Txt variant="muted">{`A new ${person} has no open ${doctype === 'Customer' ? 'invoices' : 'bills'}. If this is a new ${person}, go back and choose ${doctype === 'Customer' ? 'Customer advance' : 'Supplier payment or Expense'}.`}</Txt>
          ) : (
            <Button variant="secondary" label={`Create new ${doctype}`} onPress={() => setCreating(true)} />
          )}
        </>
      )}
    </Screen>
  );
}
