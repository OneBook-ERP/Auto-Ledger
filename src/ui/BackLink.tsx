import { Pressable, Text } from 'react-native';

/** Top-left back control ("‹ Inbox"), 48 dp. */
export function BackLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Back to ${label}`}
      className="-ml-2 mb-1 min-h-[48px] min-w-[48px] flex-row items-center self-start px-2">
      <Text className="text-[15px] font-semibold text-accent dark:text-accent-dark">‹ {label}</Text>
    </Pressable>
  );
}
