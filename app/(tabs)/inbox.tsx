import { EmptyState, Screen } from '../../src/ui';

// Placeholder for Task 18 (inbox of pending transactions). The tab name makes autoledger://inbox resolve.
export default function Inbox() {
  return (
    <Screen title="Inbox">
      <EmptyState title="No transactions to classify" message="When a bank message arrives, it shows up here with a question: what was this payment for?" />
    </Screen>
  );
}
