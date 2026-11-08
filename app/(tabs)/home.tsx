import { EmptyState, Screen } from '../../src/ui';

// Placeholder for Task 17 (dashboard).
export default function Home() {
  return (
    <Screen title="Home">
      <EmptyState title="Your balances will appear here" message="Bank balances, receivables and payables arrive in the next update. Setup is complete and AutoLedger is listening for bank messages." />
    </Screen>
  );
}
