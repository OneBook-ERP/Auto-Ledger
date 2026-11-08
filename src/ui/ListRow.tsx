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
      className="flex-row items-center border-b border-neutral-200 bg-white px-4 py-3 active:bg-neutral-100">
      <View className="flex-1">
        <Text className="text-base font-medium text-neutral-900">{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-sm text-neutral-500">{subtitle}</Text> : null}
      </View>
      {right ? <Text className="ml-3 text-base text-neutral-900">{right}</Text> : null}
    </Pressable>
  );
}
