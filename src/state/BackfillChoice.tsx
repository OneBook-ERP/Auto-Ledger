import { Pressable, Text, View } from 'react-native';
import { BACKFILL_OPTIONS } from './setup';

export const BACKFILL_QUESTION = 'How far back should we look?';

/** One-of-five choice of the message window, shown in setup and Settings. */
export function BackfillChoice({ days, onChange, disabled }: { days: number; onChange: (days: number) => void; disabled?: boolean }) {
  return (
    <View>
      <Text className="mb-2 text-base font-medium text-ink dark:text-ink-dark">{BACKFILL_QUESTION}</Text>
      <View className="flex-row flex-wrap gap-2">
        {BACKFILL_OPTIONS.map((o) => {
          const on = o.days === days;
          return (
            <Pressable
              key={o.days}
              onPress={() => onChange(o.days)}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityLabel={o.label}
              accessibilityState={{ selected: on, disabled: !!disabled }}
              className={`min-h-[48px] min-w-[48px] items-center justify-center rounded-xl border px-4 ${
                on ? 'border-accent bg-accent-soft dark:border-accent-dark dark:bg-accent-soft-dark' : 'border-line bg-surface dark:border-line-dark dark:bg-surface-dark'
              }`}>
              <Text className={`text-base ${on ? 'font-semibold text-accent dark:text-accent-dark' : 'text-ink dark:text-ink-dark'}`}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
