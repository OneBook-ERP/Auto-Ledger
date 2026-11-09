import { Text, View } from 'react-native';

export type StatusTone = 'neutral' | 'info' | 'ok' | 'warn' | 'error';

const BOX: Record<StatusTone, string> = {
  neutral: 'bg-paper dark:bg-paper-dark',
  info: 'bg-accent-soft dark:bg-accent-soft-dark',
  ok: 'bg-ok-soft dark:bg-ok-soft-dark',
  warn: 'bg-warn-soft dark:bg-warn-soft-dark',
  error: 'bg-danger-soft dark:bg-danger-soft-dark',
};
const TEXT: Record<StatusTone, string> = {
  neutral: 'text-muted dark:text-muted-dark',
  info: 'text-accent dark:text-accent-dark',
  ok: 'text-ok dark:text-ok-dark',
  warn: 'text-warn dark:text-warn-dark',
  error: 'text-danger dark:text-danger-dark',
};

/** Read-only status label (no border, never pressable). The meaning is in the words; colour only reinforces it. */
export function StatusChip({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  return (
    <View accessible accessibilityLabel={`Status: ${label}`} className={`self-start rounded-md px-2 py-0.5 ${BOX[tone]}`}>
      <Text className={`text-[13px] font-semibold ${TEXT[tone]}`}>{label}</Text>
    </View>
  );
}
