import { Pressable, Text, View } from 'react-native';

export type ActionSheetItem = { key: string; label: string; hint?: string; disabled?: boolean; disabledReason?: string };

/** The suggested answer: the one prominent choice on the Transaction screen. */
export function SuggestionCard({ title, subtitle, onPress }: { title: string; subtitle: string; onPress: () => void }) {
  return (
    <Pressable
      testID="suggestion"
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Suggested: ${title}. ${subtitle}`}
      className="mb-4 min-h-[72px] flex-row items-center rounded-2xl bg-accent px-4 py-4 active:opacity-80 dark:bg-accent-dark">
      <View className="flex-1 gap-1">
        <Text className="text-base font-bold text-white dark:text-paper-dark">{title}</Text>
        <Text className="text-[13px] leading-[18px] text-white dark:text-paper-dark">{subtitle}</Text>
      </View>
      <Text className="ml-3 text-xl text-white dark:text-paper-dark">›</Text>
    </Pressable>
  );
}

/** The full list of answers for a transaction, one row each, 56 dp tall. */
export function ActionSheet({ items, onSelect }: { items: ActionSheetItem[]; onSelect: (key: string) => void }) {
  return (
    <View testID="action-sheet" className="mb-4 rounded-2xl border border-line bg-surface dark:border-line-dark dark:bg-surface-dark">
      {items.map((a, i) => (
        <Pressable
          key={a.key}
          onPress={() => onSelect(a.key)}
          disabled={a.disabled}
          accessibilityRole="button"
          accessibilityLabel={a.label}
          accessibilityHint={a.disabled ? a.disabledReason : a.hint}
          accessibilityState={{ disabled: !!a.disabled }}
          className={`min-h-[56px] flex-row items-center px-4 py-2.5 active:bg-paper dark:active:bg-paper-dark ${i < items.length - 1 ? 'border-b border-line dark:border-line-dark' : ''} ${a.disabled ? 'opacity-60' : ''}`}>
          <View className="flex-1">
            <Text className={`text-[15px] font-medium ${a.key === 'ignore' ? 'text-muted dark:text-muted-dark' : 'text-ink dark:text-ink-dark'}`}>{a.label}</Text>
            {a.disabled && a.disabledReason ? (
              <Text className="mt-0.5 text-[13px] text-warn dark:text-warn-dark">{a.disabledReason}</Text>
            ) : a.hint ? (
              <Text className="mt-0.5 text-[13px] leading-[18px] text-muted dark:text-muted-dark">{a.hint}</Text>
            ) : null}
          </View>
          <Text className="ml-3 text-lg text-muted dark:text-muted-dark">›</Text>
        </Pressable>
      ))}
    </View>
  );
}
