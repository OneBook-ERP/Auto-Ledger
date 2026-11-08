import { ActivityIndicator, Pressable, Text } from 'react-native';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'quiet';
  loading?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

const BOX = {
  primary: 'bg-accent dark:bg-accent-dark active:opacity-80',
  secondary: 'border border-line bg-surface active:bg-paper dark:border-line-dark dark:bg-surface-dark',
  danger: 'border border-danger bg-surface active:bg-danger-soft dark:bg-surface-dark',
  quiet: 'active:bg-accent-soft dark:active:bg-accent-soft-dark',
} as const;
const TEXT = {
  primary: 'text-white dark:text-paper-dark',
  secondary: 'text-ink dark:text-ink-dark',
  danger: 'text-danger',
  quiet: 'text-accent dark:text-accent-dark',
} as const;

/** 52 dp tall touch target. `loading` disables presses and announces busy state. */
export function Button({ label, onPress, variant = 'primary', loading, disabled, accessibilityHint, testID }: ButtonProps) {
  const off = !!disabled || !!loading;
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: off, busy: !!loading }}
      className={`min-h-[52px] flex-row items-center justify-center rounded-xl px-5 ${BOX[variant]} ${off ? 'opacity-50' : ''}`}>
      {loading ? <ActivityIndicator color={variant === 'primary' ? '#FFFFFF' : '#586579'} className="mr-2" /> : null}
      <Text className={`text-base font-semibold ${TEXT[variant]}`}>{label}</Text>
    </Pressable>
  );
}
