import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

/** A grouped block. Used sparingly: only where content really is one unit (an account, a setting group). */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <View className="mb-4 rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
      {title ? <Text className="mb-2 text-lg font-semibold text-ink dark:text-ink-dark">{title}</Text> : null}
      {children}
    </View>
  );
}
