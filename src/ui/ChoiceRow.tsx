import { Pressable, Text, View } from 'react-native';

export interface ChoiceRowProps {
  title: string;
  subtitle?: string;
  selected: boolean;
  onPress: () => void;
  /** 'radio' for pick-one lists, 'checkbox' for on/off rows. */
  role?: 'radio' | 'checkbox';
  disabled?: boolean;
  testID?: string;
}

/** Full-width pick row with a leading mark. */
export function ChoiceRow({ title, subtitle, selected, onPress, role = 'radio', disabled, testID }: ChoiceRowProps) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={role}
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      accessibilityLabel={subtitle ? `${title}. ${subtitle}` : title}
      className={`mb-2 min-h-[56px] flex-row items-center rounded-xl px-4 py-2 ${
        selected
          ? 'border-2 border-accent bg-accent-soft dark:border-accent-dark dark:bg-accent-soft-dark'
          : 'border border-line bg-surface dark:border-line-dark dark:bg-surface-dark'
      } ${disabled ? 'opacity-60' : ''}`}>
      <View
        className={`mr-3 h-5 w-5 items-center justify-center border-2 ${role === 'radio' ? 'rounded-full' : 'rounded-md'} ${
          selected ? 'border-accent bg-accent dark:border-accent-dark dark:bg-accent-dark' : 'border-muted dark:border-muted-dark'
        }`}>
        {selected ? <Text accessibilityElementsHidden importantForAccessibility="no" className="text-[12px] font-bold leading-[14px] text-white dark:text-paper-dark">✓</Text> : null}
      </View>
      <View className="flex-1">
        <Text className="text-base font-medium text-ink dark:text-ink-dark">{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{subtitle}</Text> : null}
      </View>
    </Pressable>
  );
}
