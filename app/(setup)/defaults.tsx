import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { listLedgerAccounts } from '../../src/erp/docs';
import { useApp } from '../../src/state/AppProvider';
import { COMPANY_KEY, DEFAULT_EXPENSE_KEY, DRAWINGS_KEY, useSetting } from '../../src/state/useSetting';
import { Banner, Button, ChoiceRow, Screen, StepHeader, TextField } from '../../src/ui';

const SHOWN = 8;

function Picker({ label, hint, options, value, onChange }: { label: string; hint: string; options: string[]; value: string; onChange: (v: string) => void }) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? options.filter((o) => o.toLowerCase().includes(f)) : options;
    const top = list.slice(0, SHOWN);
    return value && !top.includes(value) && options.includes(value) ? [value, ...top.slice(0, SHOWN - 1)] : top;
  }, [filter, options, value]);
  return (
    <>
      <TextField label={label} hint={hint} value={filter} onChangeText={setFilter} placeholder="Search accounts" autoCapitalize="none" autoCorrect={false} />
      <ChoiceRow title="None for now" selected={value === ''} onPress={() => onChange('')} />
      {shown.map((o) => (
        <ChoiceRow key={o} title={o} selected={value === o} onPress={() => onChange(o)} />
      ))}
      {options.length > shown.length ? <Banner message={`Showing ${shown.length} of ${options.length}. Type in the search box to narrow the list.`} /> : null}
    </>
  );
}

export default function DefaultsStep() {
  const { client, repo } = useApp();
  const router = useRouter();
  const company = useSetting(COMPANY_KEY);
  const savedDrawings = useSetting(DRAWINGS_KEY);
  const savedExpense = useSetting(DEFAULT_EXPENSE_KEY);
  const [drawings, setDrawings] = useState<string | null>(null);
  const [expense, setExpense] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const on = !!client && !!company;
  const equity = useQuery({ queryKey: ['accounts', company, 'Equity'], queryFn: () => listLedgerAccounts(client!, company as string, { rootType: 'Equity' }), enabled: on });
  const liability = useQuery({ queryKey: ['accounts', company, 'Liability'], queryFn: () => listLedgerAccounts(client!, company as string, { rootType: 'Liability' }), enabled: on });
  const expenseQ = useQuery({ queryKey: ['accounts', company, 'Expense'], queryFn: () => listLedgerAccounts(client!, company as string, { rootType: 'Expense' }), enabled: on });

  useEffect(() => {
    if (drawings === null && savedDrawings !== undefined) setDrawings(savedDrawings ?? '');
    if (expense === null && savedExpense !== undefined) setExpense(savedExpense ?? '');
  }, [savedDrawings, savedExpense, drawings, expense]);

  const drawingsOptions = useMemo(() => [...(equity.data ?? []), ...(liability.data ?? [])].map((a) => a.name), [equity.data, liability.data]);
  const expenseOptions = useMemo(() => (expenseQ.data ?? []).map((a) => a.name), [expenseQ.data]);
  const failed = equity.isError || liability.isError || expenseQ.isError;
  const missing = [drawings === '' ? 'a drawings or director loan account' : null, expense === '' ? 'a default expense account' : null].filter(Boolean);

  const next = async () => {
    setSaving(true);
    try {
      await repo.setSetting(DRAWINGS_KEY, drawings ?? '');
      await repo.setSetting(DEFAULT_EXPENSE_KEY, expense ?? '');
      router.push('/(setup)/permissions');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      top={<StepHeader step={3} total={4} label="Default accounts" />}
      title="Pick your default accounts"
      subtitle="These are suggested when you classify a transaction. You can change them later by running setup again."
      footer={<Button label="Continue" onPress={next} loading={saving} disabled={drawings === null || expense === null} />}>
      {failed ? (
        <Banner tone="error" title="Could not load your accounts" message="Check your internet connection and that your ERPNext user can read Account records." actionLabel="Try again" onAction={() => { equity.refetch(); liability.refetch(); expenseQ.refetch(); }} />
      ) : null}
      {missing.length > 0 ? (
        <Banner tone="warn" title="Not set yet" message={`Without ${missing.join(' and ')}, the related choices will not be pre-filled. You can continue and set this later.`} />
      ) : null}
      <Picker
        label="Drawings or director loan account"
        hint="Where personal spending is booked. Equity and liability accounts are listed."
        options={drawingsOptions}
        value={drawings ?? ''}
        onChange={setDrawings}
      />
      <Picker label="Default expense account" hint="Used when an expense has no better match." options={expenseOptions} value={expense ?? ''} onChange={setExpense} />
    </Screen>
  );
}
