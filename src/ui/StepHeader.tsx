import { Text, View } from 'react-native';

/** "Step 2 of 4" with a progress bar. The wizard really is a sequence, so the numbering carries information. */
export function StepHeader({ step, total, label }: { step: number; total: number; label: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`Step ${step} of ${total}: ${label}`}
      className="mb-2">
      <Text className="text-sm font-medium text-muted dark:text-muted-dark">
        Step {step} of {total}
      </Text>
      <View className="mt-2 h-1.5 flex-row overflow-hidden rounded-full bg-line dark:bg-line-dark">
        <View style={{ flex: step }} className="rounded-full bg-accent dark:bg-accent-dark" />
        <View style={{ flex: total - step }} />
      </View>
    </View>
  );
}
