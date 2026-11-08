import { Text, View } from 'react-native';

/** An empty screen is an invitation: say what belongs here and what will happen. */
export function EmptyState({ title, message }: { title: string; message: string }) {
  return (
    <View className="items-center rounded-2xl border border-dashed border-line px-6 py-12 dark:border-line-dark">
      <Text accessibilityRole="header" className="text-center text-xl font-semibold text-ink dark:text-ink-dark">
        {title}
      </Text>
      <Text className="mt-2 text-center text-base leading-6 text-muted dark:text-muted-dark">{message}</Text>
    </View>
  );
}
