import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { listCompanies } from '../../src/erp/docs';
import { useApp } from '../../src/state/AppProvider';
import { useUiStore } from '../../src/state/store';
import { COMPANY_KEY, useSetting } from '../../src/state/useSetting';
import { Banner, Button, ChoiceRow, Screen, StepHeader } from '../../src/ui';

export default function CompanyStep() {
  const { client, repo } = useApp();
  const router = useRouter();
  const site = useUiStore((s) => s.session?.siteUrl ?? '');
  const saved = useSetting(COMPANY_KEY);
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const q = useQuery({ queryKey: ['companies', site], queryFn: () => listCompanies(client!), enabled: !!client });
  const companies = q.data ?? [];

  useEffect(() => {
    if (!q.data || chosen !== null || saved === undefined) return;
    const inr = q.data.filter((c) => c.currency === 'INR');
    if (saved && inr.some((c) => c.name === saved)) setChosen(saved);
    else if (q.data.length === 1 && inr.length === 1) setChosen(inr[0].name);
  }, [q.data, saved, chosen]);

  const onlyForeign = companies.length > 0 && companies.every((c) => c.currency !== 'INR');

  const next = async () => {
    if (!chosen) return;
    setSaving(true);
    setSaveFailed(false);
    try {
      await repo.setSetting(COMPANY_KEY, chosen);
      router.push('/(setup)/accounts');
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen
      top={<StepHeader step={1} total={4} label="Company" />}
      title="Choose your company"
      subtitle="AutoLedger creates draft entries in this company's books."
      footer={<Button label="Continue" onPress={next} disabled={!chosen} loading={saving} />}>
      {saveFailed ? <Banner tone="error" message="Could not save the company on this phone. Try again." /> : null}
      {q.isPending ? <Banner message="Loading your companies..." /> : null}
      {q.isError ? (
        <Banner tone="error" title="Could not load companies" message="Check your internet connection and that your ERPNext user can read Company records." actionLabel="Try again" onAction={() => q.refetch()} />
      ) : null}
      {onlyForeign ? (
        <Banner tone="warn" title="INR companies only" message="AutoLedger works with companies whose currency is INR. None of the companies on this site use INR." />
      ) : null}
      {companies.map((c) => {
        const inr = c.currency === 'INR';
        return (
          <ChoiceRow
            key={c.name}
            title={c.name}
            subtitle={inr ? 'Currency INR' : `Currency ${c.currency}. AutoLedger supports INR companies only.`}
            selected={chosen === c.name}
            disabled={!inr}
            onPress={() => setChosen(c.name)}
          />
        );
      })}
    </Screen>
  );
}
