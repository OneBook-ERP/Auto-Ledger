import { Text, View } from 'react-native';
import { Button } from './Button';
import { StatusChip, type StatusTone } from './StatusChip';

export type ActivityAction = { label: string; onPress: () => void; variant?: 'secondary' | 'danger' | 'quiet'; testID?: string };

export interface ActivityRowProps {
  title: string;
  /** Already formatted and signed, for example "+₹1,234.00". */
  amount: string;
  date: string;
  /** "Payment Entry ACC-PAY-0001" lines, shown in a monospace face. */
  docs: string[];
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
        <Text key={d} selectable className="mt-2 text-sm text-ink dark:text-ink-dark" style={{ fontFamily: 'monospace' }}>
          {d}
        </Text>
      ))}
      <View className="mt-3">
        <StatusChip label={status.label} tone={status.tone} />
      </View>
      {hint ? <Text className="mt-2 text-sm leading-5 text-muted dark:text-muted-dark">{hint}</Text> : null}
      {actions.length ? (
        <View className="mt-3 gap-2">
          {actions.map((a) => (
            <Button key={a.label} testID={a.testID} label={a.label} variant={a.variant ?? 'secondary'} onPress={a.onPress} disabled={busy} loading={busy && a.variant === 'danger'} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
