import { Pressable, Text, View } from 'react-native';
import { Pill, type PillTone } from './Pill';

export interface TxnRowProps {
  title: string;
  subtitle: string;
  amountText: string;
  /** Spoken amount, e.g. "₹30,000.00 received". */
  amountA11y: string;
  direction: 'in' | 'out';
  chip: { text: string; tone: PillTone };
  onPress: () => void;
  testID?: string;
}

/** One Inbox item: direction mark, who, where and when, the signed amount and what AutoLedger suggests. */
export function TxnRow({ title, subtitle, amountText, amountA11y, direction, chip, onPress, testID }: TxnRowProps) {
  const incoming = direction === 'in';
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amountA11y}. ${subtitle}. ${chip.text}`}
      accessibilityHint="Opens the transaction to answer it"
      className="min-h-[72px] flex-row items-start border-b border-line bg-surface px-4 py-3.5 active:bg-paper dark:border-line-dark dark:bg-surface-dark dark:active:bg-paper-dark">
      <View className={`mr-3 h-9 w-9 items-center justify-center rounded-full ${incoming ? 'bg-ok-soft dark:bg-ok-soft-dark' : 'bg-paper dark:bg-paper-dark'}`}>
        <Text className={`text-base font-bold ${incoming ? 'text-ok dark:text-ok-dark' : 'text-ink dark:text-ink-dark'}`}>{incoming ? '↙' : '↗'}</Text>
      </View>
      <View className="mr-3 flex-1 gap-1.5">
        <Text className="text-[15px] font-semibold text-ink dark:text-ink-dark">{title}</Text>
        <Text className="text-[13px] leading-[18px] text-muted dark:text-muted-dark">{subtitle}</Text>
        <Pill text={chip.text} tone={chip.tone} />
      </View>
      <Text style={{ fontVariant: ['tabular-nums'] }} className={`text-base font-semibold ${incoming ? 'text-ok dark:text-ok-dark' : 'text-ink dark:text-ink-dark'}`}>
        {amountText}
      </Text>
    </Pressable>
  );
}
