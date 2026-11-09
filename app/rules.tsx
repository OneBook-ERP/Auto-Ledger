import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { AUTO_ACTIONS, AUTO_MAX_FACTOR } from '../src/core/classify';
import { nameKey, ruleChoice } from '../src/core/suggest';
import type { PendingTxn, Rule } from '../src/core/types';
import { titleOf } from '../src/inbox/format';
import { answerText } from '../src/inbox/model';
import { useApp } from '../src/state/AppProvider';
import { gateTarget } from '../src/state/gate';
import { useUiStore } from '../src/state/store';
import { BackLink, Button, Card, EmptyState, Screen, ToggleRow, Txt, confirmDialog, formatInr } from '../src/ui';

type Row = { rule: Rule; pattern: string; answer: string; used: string; canAuto: boolean; limit: string | null };

/** "Payments to FACEBOOK SI" from the pattern key and, when one is known, the name as the bank wrote it. */
function patternText(r: Rule, names: Map<string, PendingTxn>): string {
  const [kind, dir, ...rest] = r.matchKey.split(':');
  if (kind === 'utr') return 'One payment, by its bank reference';
  const t = names.get(r.matchKey);
  const name = t ? titleOf(t) : rest.join(':');
  return `${dir === 'in' ? 'Money from' : 'Payments to'} ${name}`;
}

function rowOf(r: Rule, names: Map<string, PendingTxn>): Row | null {
  const c = ruleChoice(r);
  if (!c) return null;
  const t = names.get(r.matchKey);
  const dir = r.matchKey.split(':')[1] === 'in' ? 'in' : 'out';
  const canAuto = AUTO_ACTIONS.has(r.action) && !r.matchKey.startsWith('utr:') && r.currency === 'INR' && !!r.maxAmountMinor && r.maxAmountMinor > 0;
  return {
    rule: r,
    pattern: patternText(r, names),
    answer: answerText(c, dir, t?.accountType ?? 'bank'),
    used: `Used ${r.hits} time${r.hits === 1 ? '' : 's'}`,
    canAuto,
    limit: canAuto ? formatInr(AUTO_MAX_FACTOR * (r.maxAmountMinor as number)) : null,
  };
}

/**
 * The answers AutoLedger remembers, one per pattern: what it is, how often it was used, an on/off switch for
 * automatic answers (only for the five answers that may be automatic) and Delete. Turning a rule off or deleting
 * it stops the next automatic run; drafts already created are never touched.
 */
export default function RulesScreen() {
  const { repo } = useApp();
  const router = useRouter();
  const boot = useUiStore((s) => s.boot);
  const signedIn = useUiStore((s) => s.session !== null);
  const setupDone = useUiStore((s) => s.setupDone);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [rules, txns] = await Promise.all([repo.listRules(), repo.listPending()]);
      const names = new Map<string, PendingTxn>();
      for (const t of txns) {
        const k = nameKey(t);
        if (k && !names.has(k)) names.set(k, t);
      }
      setRows(rules.map((r) => rowOf(r, names)).filter((x): x is Row => x !== null));
    } catch {
      setRows([]);
    }
  }, [repo]);
  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  if (boot !== 'ready') return null;
  const target = gateTarget({ signedIn, setupDone });
  if (target !== '/(tabs)/home') return <Redirect href={target} />;

  // Always re-read before saving: the switch never writes back an older use count or amount.
  const setAuto = async (key: string, on: boolean) => {
    setBusy(true);
    try {
      const fresh = (await repo.listRules()).find((r) => r.matchKey === key);
      if (fresh) await repo.saveRule({ ...fresh, auto: on });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const remove = async (key: string) => {
    const ok = await confirmDialog({
      title: 'Delete this rule?',
      message: 'AutoLedger stops suggesting this answer and stops doing it automatically. Drafts already created are not changed.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await repo.deleteRule(key);
    } finally {
      setBusy(false);
      await load();
    }
  };

  return (
    <Screen
      top={<BackLink label="Settings" onPress={() => router.back()} />}
      title="Automatic rules"
      subtitle="Answers AutoLedger remembers. Switch one on to let AutoLedger answer new payments like it after each check, as drafts only.">
      {rows && rows.length === 0 ? (
        <EmptyState title="No saved answers yet" message="When you answer a payment with Remember this choice on, or answer similar payments together, the answer is kept here." />
      ) : null}
      {(rows ?? []).map((row) => (
        <View key={row.rule.matchKey} testID={`rule-${row.rule.matchKey}`}>
          <Card>
            <Txt variant="strong">{row.pattern}</Txt>
            <Txt variant="body">{row.answer}</Txt>
            <Txt variant="muted">{row.used}</Txt>
            <View className="mt-3">
              {row.canAuto ? (
                <ToggleRow
                  title="Do this automatically"
                  subtitle={`For new payments up to ${row.limit}. Never for one that may already be in ERPNext.`}
                  value={row.rule.auto === true}
                  onChange={(v) => void setAuto(row.rule.matchKey, v)}
                  testID={`auto-${row.rule.matchKey}`}
                />
              ) : (
                <Txt variant="muted">This answer is only suggested. You confirm it one payment at a time.</Txt>
              )}
            </View>
            <Button variant="danger" label="Delete" disabled={busy} onPress={() => void remove(row.rule.matchKey)} testID={`delete-${row.rule.matchKey}`} />
          </Card>
        </View>
      ))}
    </Screen>
  );
}
