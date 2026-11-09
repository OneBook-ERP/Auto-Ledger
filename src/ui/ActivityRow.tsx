import { Pressable, Text, View } from 'react-native';
import { Button } from './Button';
import { StatusChip, type StatusTone } from './StatusChip';

export type ActivityAction = { label: string; onPress: () => void; variant?: 'secondary' | 'danger' | 'quiet'; testID?: string };

export interface ActivityRowProps {
  title: string;
  /** Already formatted and signed, for example "+₹1,234.00". */
  amount: string;
  /** Already formatted, for example "8 Nov 2026". */
  date: string;
  /** One line per ERPNext document: a friendly kind ("Payment entry") and its id in small monospace text. */
  docs: { kind: string; id: string }[];
  status: { label: string; tone: StatusTone };
  /** Short explanation under the status, for example what "Not found" means. */
  hint?: string;
  actions: ActivityAction[];
  busy?: boolean;
  testID?: string;
}

/** One processed message: who, how much, which ERPNext documents, where it stands and what can be done. */
export function ActivityRow({ title, amount, date, docs, status, hint, actions, busy, testID }: ActivityRowProps) {
  return (
    <View testID={testID} className="mb-3 rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
      <View className="flex-row items-start justify-between">
        <View className="mr-3 flex-1">
          <Text className="text-base font-semibold text-ink dark:text-ink-dark">{title}</Text>
          <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{date}</Text>
        </View>
        <Text className="text-base font-semibold text-ink dark:text-ink-dark">{amount}</Text>
      </View>
      {docs.map((d) => (
        <View key={`${d.kind}-${d.id}`} className="mt-2 flex-row items-baseline">
          <Text className="text-sm text-ink dark:text-ink-dark">{d.kind}</Text>
          <Text selectable className="ml-2 text-xs text-muted dark:text-muted-dark" style={{ fontFamily: 'monospace' }}>
            {d.id}
          </Text>
        </View>
      ))}
      <View className="mt-3">
        <StatusChip label={status.label} tone={status.tone} />
      </View>
      {hint ? <Text className="mt-2 text-sm leading-5 text-muted dark:text-muted-dark">{hint}</Text> : null}
      {actions.length ? (
        <View className="mt-1 flex-row flex-wrap items-center justify-between">
          {actions.map((a) =>
            a.variant === 'danger' ? (
              // Undo is quiet: error-coloured text, not a large outlined button.
              <Pressable
                key={a.label}
                testID={a.testID}
                onPress={a.onPress}
                disabled={busy}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                accessibilityState={{ disabled: !!busy, busy: !!busy }}
                className={`min-h-[48px] justify-center pr-4 ${busy ? 'opacity-50' : ''}`}>
                <Text className="text-base font-semibold text-danger dark:text-danger-dark">{a.label}</Text>
              </Pressable>
            ) : (
              <View key={a.label} className="flex-1">
                <Button testID={a.testID} label={a.label} variant={a.variant ?? 'secondary'} onPress={a.onPress} disabled={busy} />
              </View>
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}
