import { Pressable, Text, View } from 'react-native';

export interface ListRowProps {
  title: string;
  subtitle?: string;
  right?: string;
  onPress?: () => void;
}

/** Kit-agnostic list row. Screens import this, never the UI kit directly. */
export function ListRow({ title, subtitle, right, onPress }: ListRowProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      className="min-h-[56px] flex-row items-center border-b border-line bg-surface px-4 py-3 active:bg-paper dark:border-line-dark dark:bg-surface-dark dark:active:bg-paper-dark">
      <View className="flex-1">
        <Text className="text-base font-medium text-ink dark:text-ink-dark">{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{subtitle}</Text> : null}
      </View>
      {right ? <Text className="ml-3 text-base text-ink dark:text-ink-dark">{right}</Text> : null}
    </Pressable>
  );
}
