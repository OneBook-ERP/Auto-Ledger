import type { ReactNode } from 'react';
import { RefreshControl, ScrollView } from 'react-native';

/** A scrolling list with pull-to-refresh, for use inside a non-scrolling Screen. */
export function RefreshScroll({ children, refreshing, onRefresh, testID }: { children: ReactNode; refreshing: boolean; onRefresh: () => void; testID?: string }) {
  return (
    <ScrollView
      testID={testID}
      className="-mx-5 flex-1"
      contentContainerClassName="px-5 pb-8"
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} accessibilityLabel="Check for new bank messages" />}>
      {children}
    </ScrollView>
  );
}
