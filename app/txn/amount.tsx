import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { nextStep } from '../../src/inbox/actions';
import { FlowAnswered, FlowGone, FlowLoading } from '../../src/inbox/FlowStates';
import { parseRupees, toPaise } from '../../src/inbox/flow';
import { plainAmount } from '../../src/inbox/format';
import { stepHref, useTxnFlow } from '../../src/inbox/hooks';
import { BackLink, Button, Screen, TextField, Txt } from '../../src/ui';

export const RUPEE_LABEL = 'Amount in rupees';

/**
 * Foreign-currency card spend: the rupee amount is required. The planner cannot create a document without it
 * (and the runner refuses a plan that still needs it), so "leave it for my accountant" is not offered.
 */
export default function AmountStep() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const f = useTxnFlow(id);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();

  if (f.status === 'loading') return <FlowLoading />;
  if (f.status === 'missing' || !f.txn) return <FlowGone onInbox={() => router.navigate('/(tabs)/inbox')} />;
  const txn = f.txn;
  if (txn.state !== 'new') return <FlowAnswered state={txn.state} onInbox={() => router.navigate('/(tabs)/inbox')} onActivity={() => router.navigate('/(tabs)/activity')} />;

  const value = text ?? (f.draft.inrAmountMinor !== undefined ? toPaise(f.draft.inrAmountMinor) : '');
  const onContinue = () => {
    const minor = parseRupees(value);
    if (minor === null) return setError('Enter the rupee amount, for example 8,512.40.');
    f.patch({ inrAmountMinor: minor });
    router.push(stepHref(nextStep(txn, { ...f.draft, inrAmountMinor: minor }), txn.id));
  };

  return (
    <Screen
      top={<BackLink label="Back" onPress={() => router.back()} />}
      title="How much was it in rupees?"
      subtitle={`The bank message shows ${plainAmount(txn)} but not the rupee amount charged to your card.`}
      footer={<Button label="Continue" onPress={onContinue} />}>
      <TextField
        label={RUPEE_LABEL}
        value={value}
        onChangeText={(t) => {
          setText(t);
          setError(undefined);
        }}
        keyboardType="decimal-pad"
        placeholder="0.00"
        hint="Use the amount on your card statement or the card app."
        error={error}
        autoFocus
      />
      <Txt variant="muted">If you do not know it yet, leave this message in the Inbox and answer it when your statement arrives.</Txt>
    </Screen>
  );
}
