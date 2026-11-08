import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { listBankAccounts, listModesOfPayment } from '../../src/erp/docs';
import { useApp } from '../../src/state/AppProvider';
import { NOT_SUPPORTED, buildDrafts, validateDrafts, type AccountDraft } from '../../src/state/setup';
import { useUiStore } from '../../src/state/store';
import { COMPANY_KEY, useSetting } from '../../src/state/useSetting';
import { Banner, Button, Card, Chip, ChoiceRow, Screen, StepHeader, TextField } from '../../src/ui';

export const SAVED_NOTE = 'Already saved. Saved accounts cannot be removed from the app yet; edit their details below.';

export default function AccountsStep() {
  const { client, repo } = useApp();
  const router = useRouter();
  const site = useUiStore((s) => s.session?.siteUrl ?? '');
  const company = useSetting(COMPANY_KEY);
  const [drafts, setDrafts] = useState<AccountDraft[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [none, setNone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const accountsQ = useQuery({
    queryKey: ['bank-accounts', site, company],
    queryFn: () => listBankAccounts(client!, company as string),
    enabled: !!client && !!company,
  });
  const modesQ = useQuery({ queryKey: ['modes-of-payment', site], queryFn: () => listModesOfPayment(client!), enabled: !!client });
  const mappingsQ = useQuery({ queryKey: ['mappings', site], queryFn: () => repo.listMappings(), gcTime: 0 });

  useEffect(() => {
    if (drafts || !accountsQ.data || !modesQ.data || !mappingsQ.data) return;
    // A saved mapping always shows, even if its Bank Account is not listed as a company account any more.
    const listed = accountsQ.data.filter((a) => a.isCompanyAccount || mappingsQ.data.some((m) => m.bankAccount === a.name));
    setDrafts(buildDrafts(listed, mappingsQ.data, modesQ.data));
  }, [drafts, accountsQ.data, modesQ.data, mappingsQ.data]);

  const patch = (name: string, p: Partial<AccountDraft>) => {
    setNone(false);
    setDrafts((d) => d && d.map((x) => (x.bankAccount === name ? { ...x, ...p } : x)));
  };

  const next = async () => {
    if (!drafts) return;
    const r = validateDrafts(drafts);
    setErrors(r.errors);
    setNone(r.none);
    if (r.none || Object.keys(r.errors).length > 0) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      // Saved mappings are only added or updated here, never removed, so a re-run cannot lose any.
      for (const m of r.mappings) await repo.saveMapping(m);
      router.push('/(setup)/defaults');
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const modes = modesQ.data ?? [];
  const failed = accountsQ.isError || modesQ.isError;

  return (
    <Screen
      top={<StepHeader step={2} total={4} label="Accounts" />}
      title="Which accounts send SMS alerts?"
      subtitle="Choose the bank and card accounts AutoLedger should read messages for. At least one is needed."
      footer={<Button label="Continue" onPress={next} loading={saving} disabled={!drafts} />}>
      {failed ? (
        <Banner tone="error" title="Could not load your accounts" message="Check your internet connection and that your ERPNext user can read Bank Account and Mode of Payment records." actionLabel="Try again" onAction={() => { accountsQ.refetch(); modesQ.refetch(); }} />
      ) : null}
      {!drafts && !failed ? <Banner message="Loading your bank accounts..." /> : null}
      {drafts && drafts.length === 0 ? (
        <Banner tone="warn" title="No bank accounts found" message="Add your bank and card accounts as Bank Account records in ERPNext, then run setup again." />
      ) : null}
      {none ? <Banner tone="warn" message="Select at least one account to continue." /> : null}
      {saveFailed ? <Banner tone="error" message="Could not save the accounts on this phone. Try again." /> : null}
      {drafts?.map((d) => (
        <View key={d.bankAccount} className="mb-3">
          <ChoiceRow
            role="checkbox"
            title={d.bankAccount}
            subtitle={!d.supported ? NOT_SUPPORTED : d.saved ? SAVED_NOTE : undefined}
            selected={d.selected}
            disabled={!d.supported || d.saved}
            onPress={() => patch(d.bankAccount, { selected: !d.selected })}
          />
          {d.selected ? (
            <Card>
              <Text className="mb-2 text-sm font-medium text-ink dark:text-ink-dark">Type</Text>
              <View className="flex-row flex-wrap">
                <Chip label="Bank account" selected={d.kind === 'bank'} onPress={() => patch(d.bankAccount, { kind: 'bank' })} />
                <Chip label="Credit card" selected={d.kind === 'card'} onPress={() => patch(d.bankAccount, { kind: 'card' })} />
              </View>
              <TextField
                label={`Sender id for ${d.bankAccount}`}
                value={d.senders}
                onChangeText={(t) => patch(d.bankAccount, { senders: t })}
                hint="The name the bank's messages come from. IDFC First uses IDFCFB."
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <TextField
                label={`Last 4 digits for ${d.bankAccount}`}
                value={d.last4}
                onChangeText={(t) => patch(d.bankAccount, { last4: t })}
                placeholder="3455, 8129"
                hint="If several cards share this ERPNext account, enter each one, separated by commas."
                keyboardType="numbers-and-punctuation"
                autoCorrect={false}
                error={errors[d.bankAccount]}
              />
              <Text className="mb-2 text-sm font-medium text-ink dark:text-ink-dark">Default mode of payment</Text>
              <View className="flex-row flex-wrap">
                {modes.map((m) => (
                  <Chip key={m.name} label={m.name} selected={d.modeOfPayment === m.name} onPress={() => patch(d.bankAccount, { modeOfPayment: m.name })} />
                ))}
              </View>
            </Card>
          ) : null}
        </View>
      ))}
    </Screen>
  );
}
