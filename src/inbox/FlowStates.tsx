// Shared not-ready states of the flow screens (loading, gone, already answered).
import { Banner, Button, EmptyState, Screen } from '../ui';

export function FlowLoading() {
  return (
    <Screen>
      <Banner message="Loading the transaction..." />
    </Screen>
  );
}

export function FlowGone({ onInbox }: { onInbox: () => void }) {
  return (
    <Screen footer={<Button label="Back to Inbox" onPress={onInbox} />}>
      <EmptyState title="This transaction is not here any more" message="It may have been answered already. Your Inbox shows what still needs an answer." />
    </Screen>
  );
}

export function FlowAnswered({ state, onActivity, onInbox }: { state: string; onActivity: () => void; onInbox: () => void }) {
  const ignored = state === 'ignored';
  return (
    <Screen
      title={ignored ? 'Already ignored' : 'Already answered'}
      subtitle={ignored ? 'This message was ignored, so nothing was added to ERPNext.' : 'A draft for this transaction is already in ERPNext. To change it, use Undo in Activity.'}
      footer={<Button label="Back to Inbox" onPress={onInbox} />}>
      <Button variant="secondary" label="See it in Activity" onPress={onActivity} />
    </Screen>
  );
}
