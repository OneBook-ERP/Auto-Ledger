import { memo } from 'react';
import { Pressable, Text, useColorScheme, View } from 'react-native';
import { Icon, type IconName } from './Icon';
import { Pill, type PillTone } from './Pill';

export interface TxnRowProps {
  title: string;
  subtitle: string;
  amountText: string;
  /** Spoken amount, e.g. "₹30,000.00 received". */
  amountA11y: string;
  direction: 'in' | 'out';
  chip: { text: string; tone: PillTone };
  /** How the money moved; defaults to a bank. */
  kindIcon?: Extract<IconName, 'card' | 'upi' | 'bank'>;
  onPress: () => void;
  testID?: string;
}

// Theme-aware colours for SVG strokes (NativeWind classes do not reach them): ink / money-in / money-out tokens of tailwind.config.js.
const INK = { light: '#0E1A2E', dark: '#EDF1F8' };
const MONEY_IN = { light: '#0F6B3F', dark: '#4ADE80' };
const MONEY_OUT = { light: '#A3203D', dark: '#FF8FA3' };

/** One Inbox item: how it was paid, who, where and when, the signed amount (green in, rose out) and the suggestion. */
export const TxnRow = memo(function TxnRow({ title, subtitle, amountText, amountA11y, direction, chip, kindIcon = 'bank', onPress, testID }: TxnRowProps) {
  const incoming = direction === 'in';
  const dark = useColorScheme() === 'dark';
  const mode = dark ? 'dark' : 'light';
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${amountA11y}. ${subtitle}. ${chip.text}`}
      accessibilityHint="Opens the transaction to answer it"
      className="min-h-[72px] flex-row items-start border-b border-line bg-surface px-4 py-3.5 active:bg-paper dark:border-line-dark dark:bg-surface-dark dark:active:bg-paper-dark">
      <View className="mr-3 h-9 w-9 items-center justify-center rounded-full bg-paper dark:bg-paper-dark">
        <Icon name={kindIcon} size={18} color={INK[mode]} />
      </View>
      <View className="mr-3 flex-1 gap-1.5">
        <Text numberOfLines={2} ellipsizeMode="tail" className="text-[15px] font-semibold text-ink dark:text-ink-dark">{title}</Text>
        <Text className="text-[13px] leading-[18px] text-muted dark:text-muted-dark">{subtitle}</Text>
        <Pill text={chip.text} tone={chip.tone} />
      </View>
      <View className="shrink-0 flex-row items-center gap-1">
        <Icon name={incoming ? 'moneyIn' : 'moneyOut'} size={14} color={incoming ? MONEY_IN[mode] : MONEY_OUT[mode]} />
        <Text
          numberOfLines={1}
          style={{ fontVariant: ['tabular-nums'] }}
          className={`text-base font-semibold ${incoming ? 'text-money-in dark:text-money-in-dark' : 'text-money-out dark:text-money-out-dark'}`}>
          {amountText}
        </Text>
      </View>
    </Pressable>
  );
});
