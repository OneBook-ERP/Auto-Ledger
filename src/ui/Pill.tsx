import { Text, View } from 'react-native';

export type PillTone = 'accent' | 'warn' | 'plain' | 'ok';
const BOX: Record<PillTone, string> = {
  accent: 'bg-accent-soft dark:bg-accent-soft-dark',
  warn: 'bg-warn-soft dark:bg-warn-soft-dark',
  ok: 'bg-ok-soft dark:bg-ok-soft-dark',
  plain: 'border border-line dark:border-line-dark',
};
const TEXT: Record<PillTone, string> = {
  accent: 'text-accent dark:text-accent-dark',
  warn: 'text-warn dark:text-warn-dark',
  ok: 'text-ok dark:text-ok-dark',
  plain: 'text-muted dark:text-muted-dark',
};

/** A static status label (not pressable; use Chip for a choice). */
export function Pill({ text, tone = 'plain', testID }: { text: string; tone?: PillTone; testID?: string }) {
  return (
    <View testID={testID} className={`self-start rounded-full px-2.5 py-1 ${BOX[tone]}`}>
      <Text className={`text-xs font-semibold ${TEXT[tone]}`}>{text}</Text>
    </View>
  );
}
