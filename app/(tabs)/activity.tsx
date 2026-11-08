import { EmptyState, Screen } from '../../src/ui';

// Placeholder for Task 19 (activity log with Undo).
export default function Activity() {
  return (
    <Screen title="Activity">
      <EmptyState title="Nothing processed yet" message="Entries you create from the Inbox are listed here, with an option to undo each draft." />
    </Screen>
  );
}
