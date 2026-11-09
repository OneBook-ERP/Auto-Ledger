import { Pressable, Text } from 'react-native';

export interface GroupCardProps {
  /** "40 payments to Facebook, ₹1,24,000.00 in total". */
  title: string;
  /** "Suggested: Expense, Advertising" or "Choose what these were". */
  answer: string;
  onPress: () => void;
  testID?: string;
}

/** Similar waiting payments that can be answered together; opens the screen that answers them in one go. */
export function GroupCard({ title, answer, onPress, testID }: GroupCardProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${answer}`}
      accessibilityHint="Opens them to answer them together"
      className="mb-2 min-h-[72px] rounded-2xl border border-line bg-surface px-4 py-3 active:bg-paper dark:border-line-dark dark:bg-surface-dark dark:active:bg-paper-dark">
      <Text className="text-[15px] font-semibold text-ink dark:text-ink-dark">{title}</Text>
      <Text className="mt-1 text-[13px] leading-[18px] text-muted dark:text-muted-dark">{answer}</Text>
      <Text className="mt-2 text-sm font-semibold text-accent dark:text-accent-dark">Answer them together</Text>
    </Pressable>
  );
}
