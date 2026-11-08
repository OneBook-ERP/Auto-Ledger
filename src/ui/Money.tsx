import { Text } from 'react-native';
import { formatInr } from './format';

/** Large tabular rupee figure so columns of amounts line up. */
export function Money({ minor, size = 'lg' }: { minor: number; size?: 'md' | 'lg' | 'xl' }) {
  const cls = size === 'xl' ? 'text-4xl' : size === 'lg' ? 'text-2xl' : 'text-lg';
  return (
    <Text
      accessibilityLabel={formatInr(minor).replace('₹', 'rupees ')}
      style={{ fontVariant: ['tabular-nums'] }}
      className={`${cls} font-semibold tracking-tight text-ink dark:text-ink-dark`}>
      {formatInr(minor)}
    </Text>
  );
}
