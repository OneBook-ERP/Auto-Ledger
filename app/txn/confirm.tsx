import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { learnRule } from '../../src/core/suggest';
import type { ActionChoice, ActionPlan } from '../../src/core/types';
import { rememberDefault, rememberShown } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { describeStep, stepTitle } from '../../src/inbox/describe';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { planFor } from '../../src/inbox/flow';
import { istToday, titleOf } from '../../src/inbox/format';
import { useTxnFlow } from '../../src/inbox/hooks';
import { erpNewDocUrl, planErrorMessage, type Outcome } from '../../src/inbox/outcome';
import { useFlowStore } from '../../src/inbox/store';
import { submitAnswer } from '../../src/inbox/submit';
import { BackLink, Banner, Button, DetailCard, Pill, Screen, Stack, ToggleRow, Txt, confirmDialog, openExternal } from '../../src/ui';

export const DRAFT_NOTE = 'It is saved as a draft. Your accountant submits it and matches it to the bank statement in ERPNext.';
export const IGNORE_TITLE = 'Ignore this message?';
export const IGNORE_MESSAGE = 'It will not be added to ERPNext.';

type Prepared = { plan: ActionPlan; choice: ActionChoice } | { error: string };

export default function ConfirmStep() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const deps = useInboxDeps();
  const f = useTxnFlow(id);
  const txn = f.txn;
  const action = f.draft.action;
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<Extract<Outcome, { kind: 'error' }> | null>(null);
  const [remember, setRemember] = useState(action ? rememberDefault(action) : false);

  const prepared = useMemo<Prepared | null>(() => {
    if (!txn || !action) return null;
    try {
      return planFor(txn, f.draft, { company: f.settings.company, drawingsAccount: f.settings.drawingsAccount, today: istToday(deps.now()) });
    } catch (e) {
      return { error: planErrorMessage(e) };
    }
  }, [txn, action, f.draft, f.settings, deps]);
  const ok = prepared && 'plan' in prepared ? prepared : null;

  // "Create draft" is enabled only after the summary has been committed to the screen.
  useEffect(() => {
    setShown(!!ok);
  }, [ok]);

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !txn || !action) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const nothing = !!ok && ok.choice.type === 'ignore';
  const learnable = !!ok && rememberShown(action) && learnRule(txn, ok.choice, []).length > 0;
  const who = txn.counterparty ?? txn.merchant;

  const create = async () => {
    if (!ok || !shown || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (nothing && !(await confirmDialog({ title: IGNORE_TITLE, message: IGNORE_MESSAGE, confirmLabel: 'Ignore' }))) return;
      if (!deps.erp) {
        router.push('/(auth)/login');
        return;
      }
      const o = await submitAnswer(
        { repo: deps.repo, erp: deps.erp, runPlan: deps.runPlan },
        { txn, plan: ok.plan, choice: ok.choice, remember: learnable && remember },
      );
      switch (o.kind) {
        case 'created':
          useFlowStore.getState().clear(txn.id);
          router.dismissAll();
          router.push({ pathname: '/txn/result', params: { id: txn.id } });
          return;
        case 'login':
          router.push('/(auth)/login');
          return;
        case 'offline':
          useFlowStore.getState().clear(txn.id);
          useFlowStore.getState().setFlash(o.message);
          router.dismissTo('/(tabs)/inbox');
          return;
        case 'error':
          setFailure(o);
          return;
        default:
          return; // busy: another submit for this txn is running
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const primary = nothing ? 'Ignore this message' : 'Create draft';
  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title={nothing ? 'Nothing will be created' : 'Check before creating'}
      subtitle={nothing ? undefined : 'This is what will be added to ERPNext.'}
      footer={
        <Stack gap={2}>
          <Button label={primary} onPress={create} loading={busy} disabled={!ok || !shown} testID="create" />
          <Button variant="quiet" label="Change my answer" onPress={() => router.dismissTo({ pathname: '/txn/[id]', params: { id: txn.id } })} />
        </Stack>
      }>
      {prepared && 'error' in prepared ? <Banner tone="error" title="This cannot be created yet" message={prepared.error} /> : null}
      {failure ? (
        <Banner
          tone="error"
          title="ERPNext did not accept this"
          message={[
            failure.message,
            failure.missingFields.length ? `ERPNext needs: ${failure.missingFields.join(', ')}` : '',
            failure.doctype ? `You can also open ERPNext and create the ${failure.doctype} there.` : '',
          ].filter(Boolean).join('\n\n')}
          actionLabel={failure.doctype && deps.siteUrl ? 'Open in ERPNext' : undefined}
          onAction={() => failure.doctype && void openExternal(erpNewDocUrl(deps.siteUrl, failure.doctype))}
          testID="failure"
        />
      ) : null}
      {ok && nothing ? <Banner tone="info" message={ok.plan.summary.join('\n')} testID="summary" /> : null}
      {ok && !nothing ? (
        <Stack gap={1}>
          {ok.plan.steps.map((s, i) => (
            <DetailCard key={`${s.kind}-${i}`} title={stepTitle(s)} badge={<Pill text="Draft" tone="warn" />} rows={describeStep(s)} testID={`summary-${i}`}>
              <Txt variant="muted">{ok.plan.summary[i]}</Txt>
            </DetailCard>
          ))}
          <Banner tone="info" message={DRAFT_NOTE} />
        </Stack>
      ) : null}
      {ok && learnable ? (
        <ToggleRow
          testID="remember"
          title="Remember this choice"
          subtitle={who ? `Suggest it next time ${titleOf(txn)} ${txn.direction === 'in' ? 'pays you' : 'is paid'}.` : 'Suggest it next time.'}
          value={remember}
          onChange={setRemember}
        />
      ) : null}
    </Screen>
  );
}
