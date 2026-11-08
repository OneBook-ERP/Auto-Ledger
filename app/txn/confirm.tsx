import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { learnRule } from '../../src/core/suggest';
import type { ActionChoice, ActionPlan } from '../../src/core/types';
import { rememberDefault, rememberShown } from '../../src/inbox/actions';
import { useInboxDeps } from '../../src/inbox/deps';
import { describeStep, stepTitle } from '../../src/inbox/describe';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { counterMappingOf, findCounterpartLeg, SEVERAL_TRANSFERS_WARNING, type CounterpartLink } from '../../src/inbox/counterpart';
import { foreignAmountCheck, planFor } from '../../src/inbox/flow';
import { istToday, titleOf } from '../../src/inbox/format';
import { useTxnFlow } from '../../src/inbox/hooks';
import { GONE_MESSAGE, UNKNOWN_FAILURE, erpNewDocUrl, planErrorMessage, type Outcome } from '../../src/inbox/outcome';
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
  const sending = useFlowStore((st) => (id ? !!st.sending[id] : false));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The other leg of an own-account transfer, when both accounts are read (R54): looked up before planning.
  const [link, setLink] = useState<CounterpartLink | null>(null);
  useEffect(() => {
    if (!txn || !action) return;
    let live = true;
    const counter = counterMappingOf(f.draft, txn.direction, f.mappings);
    if (!counter) {
      setLink({ status: 'none' });
      return;
    }
    setLink(null);
    findCounterpartLeg(txn, counter, deps.repo, f.mappings).then(
      (l) => live && setLink(l),
      () => live && setLink({ status: 'none' }),
    );
    return () => {
      live = false;
    };
  }, [txn, action, f.draft, f.mappings, deps.repo]);

  const prepared = useMemo<Prepared | null>(() => {
    if (!txn || !action || !link) return null;
    try {
      const extra = link.status === 'linked' ? { referenceOverride: link.reference } : {};
      return planFor(txn, f.draft, { company: f.settings.company, drawingsAccount: f.settings.drawingsAccount, today: istToday(deps.now()) }, extra);
    } catch (e) {
      return { error: planErrorMessage(e) };
    }
  }, [txn, action, f.draft, f.settings, deps, link]);
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
    const store = useFlowStore.getState;
    // The answers this run was started with: a finished run never clears a NEWER draft for the txn.
    const used = store().drafts[txn.id];
    const clearOwnDraft = () => {
      if (store().drafts[txn.id] === used) store().clear(txn.id);
    };
    try {
      if (nothing && !(await confirmDialog({ title: IGNORE_TITLE, message: IGNORE_MESSAGE, confirmLabel: 'Ignore' }))) return;
      if (!deps.erp) {
        router.push('/(auth)/login');
        return;
      }
      store().setSending(txn.id, true);
      let o: Outcome;
      try {
        o = await submitAnswer(
          { repo: deps.repo, erp: deps.erp, runPlan: deps.runPlan },
          { txn, plan: ok.plan, choice: ok.choice, remember: learnable && remember },
        );
      } catch {
        o = { kind: 'error', message: UNKNOWN_FAILURE, missingFields: [], doctype: null, closedPeriod: false };
      } finally {
        store().setSending(txn.id, false);
      }
      // Notices that belong to the Inbox are kept even when this screen is gone; navigation is not.
      switch (o.kind) {
        case 'created': {
          clearOwnDraft();
          if (!mounted.current) return;
          const inr = txn.currency !== 'INR' && f.draft.inrAmountMinor !== undefined ? { inr: String(f.draft.inrAmountMinor) } : {};
          router.dismissAll();
          router.push({ pathname: '/txn/result', params: { id: txn.id, ...inr } });
          return;
        }
        case 'login':
          if (mounted.current) router.push('/(auth)/login');
          return;
        case 'offline':
          clearOwnDraft();
          store().setFlash(o.message);
          if (mounted.current) router.dismissTo('/(tabs)/inbox');
          return;
        case 'gone':
          clearOwnDraft();
          store().setFlash(GONE_MESSAGE);
          if (mounted.current) router.dismissTo('/(tabs)/inbox');
          return;
        case 'error':
          if (mounted.current) setFailure(o);
          return;
        default:
          return; // busy: another submit for this txn is running
      }
    } catch {
      if (mounted.current) setFailure({ kind: 'error', message: UNKNOWN_FAILURE, missingFields: [], doctype: null, closedPeriod: false });
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const foreign = txn.currency !== 'INR' && f.draft.inrAmountMinor !== undefined ? foreignAmountCheck(txn, f.draft.inrAmountMinor) : null;
  const primary = nothing ? 'Ignore this message' : 'Create draft';
  return (
    <Screen
      top={<BackLink label="Back" disabled={busy} onPress={() => router.back()} />}
      title={nothing ? 'Nothing will be created' : 'Check before creating'}
      subtitle={nothing ? undefined : 'This is what will be added to ERPNext.'}
      footer={
        <Stack gap={2}>
          <Button label={primary} onPress={create} loading={busy} disabled={!ok || !shown} testID="create" />
          <Button variant="quiet" label="Change my answer" disabled={busy} onPress={() => router.dismissTo({ pathname: '/txn/[id]', params: { id: txn.id } })} />
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
      {sending ? <Banner tone="info" message="Sending your answer to ERPNext. Stay on this screen until it finishes." testID="sending" /> : null}
      {ok && link?.status === 'linked' ? (
        <DetailCard rows={[{ label: 'Linked', value: `Linked to the transfer already recorded from ${link.counterLabel}'s message (${link.docName})` }]} testID="linked" />
      ) : null}
      {ok && link?.status === 'several' ? <Banner tone="warn" message={SEVERAL_TRANSFERS_WARNING} testID="several" /> : null}
      {ok && !nothing && foreign ? (
        <>
          <DetailCard rows={[{ label: 'Card amount', value: foreign.text }]} testID="foreign" />
          {foreign.warning ? <Banner tone="warn" message={foreign.warning} testID="rate-warning" /> : null}
        </>
      ) : null}
      {ok && !nothing ? (
        <Stack gap={1}>
          {ok.plan.steps.map((s, i) => (
            <DetailCard key={`${s.kind}-${i}`} title={stepTitle(s)} badge={<Pill text="Draft" tone="warn" />} rows={describeStep(s, s.kind === 'create_party' ? f.draft.newParty?.labels : undefined)} testID={`summary-${i}`}>
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
