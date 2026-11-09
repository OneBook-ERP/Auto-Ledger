import type { ReactElement, ReactNode } from 'react';
import { FlatList, RefreshControl, ScrollView, type ListRenderItem } from 'react-native';

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

export interface RefreshListProps<T> {
  data: T[];
  renderItem: ListRenderItem<T>;
  keyExtractor: (item: T) => string;
  header?: ReactElement | null;
  refreshing: boolean;
  onRefresh: () => void;
  onEndReached?: () => void;
  testID?: string;
}

/** A virtualised list with pull-to-refresh: only rows near the screen are mounted. Rows are not given a fixed height (wrapped titles and large text change it). */
export function RefreshList<T>({ data, renderItem, keyExtractor, header, refreshing, onRefresh, onEndReached, testID }: RefreshListProps<T>) {
  return (
    <FlatList
      testID={testID}
      className="-mx-5 flex-1"
      contentContainerClassName="px-5 pb-8"
      data={data}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={header ?? undefined}
      onEndReached={onEndReached}
      onEndReachedThreshold={1.5}
      initialNumToRender={12}
      maxToRenderPerBatch={10}
      windowSize={7}
      removeClippedSubviews
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} accessibilityLabel="Check for new bank messages" />}
    />
  );
}
