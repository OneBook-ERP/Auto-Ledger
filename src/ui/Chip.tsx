import { Pressable, Text } from 'react-native';

export interface ChipProps {
  label: string;
  selected: boolean;
  onPress: () => void;
  disabled?: boolean;
}

/** Selectable pill (radio semantics), 48 dp tall. */
export function Chip({ label, selected, onPress, disabled }: ChipProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, disabled: !!disabled }}
      accessibilityLabel={label}
      className={`mb-2 mr-2 min-h-[48px] justify-center rounded-full border px-4 ${
        selected
          ? 'border-accent bg-accent-soft dark:border-accent-dark dark:bg-accent-soft-dark'
          : 'border-line bg-surface dark:border-line-dark dark:bg-surface-dark'
      } ${disabled ? 'opacity-50' : ''}`}>
      <Text className={`text-[15px] ${selected ? 'font-semibold text-accent dark:text-accent-dark' : 'text-ink dark:text-ink-dark'}`}>{label}</Text>
    </Pressable>
  );
}
