import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

export type Detail = { label: string; value: string; mono?: boolean; strong?: boolean };

/** Label / value rows in one bordered block (transaction facts, what a draft will contain). */
export function DetailCard({ title, badge, rows, more, children, testID }: { title?: string; badge?: ReactNode; rows: Detail[]; /** Extra facts behind a collapsed "Details" row. */ more?: Detail[]; children?: ReactNode; testID?: string }) {
  const [open, setOpen] = useState(false);
  const extra = more ?? [];
  return (
    <View testID={testID} className="mb-4 rounded-2xl border border-line bg-surface dark:border-line-dark dark:bg-surface-dark">
      {title ? (
        <View className="flex-row items-center justify-between gap-3 border-b border-line px-4 py-3.5 dark:border-line-dark">
          <Text accessibilityRole="header" className="flex-1 text-base font-bold text-ink dark:text-ink-dark">{title}</Text>
          {badge}
        </View>
      ) : null}
      {children ? <View className="px-4 pt-3">{children}</View> : null}
      {rows.map((r, i) => (
        <Line key={r.label} r={r} last={i === rows.length - 1 && extra.length === 0} />
      ))}
      {extra.length > 0 ? (
        <>
          <Pressable
            testID="details-toggle"
            onPress={() => setOpen((o) => !o)}
            accessibilityRole="button"
            accessibilityLabel="Details"
            accessibilityState={{ expanded: open }}
            className={`min-h-[48px] flex-row items-center justify-between px-4 py-3 ${open ? 'border-b border-line dark:border-line-dark' : ''}`}>
            <Text className="text-[13px] text-muted dark:text-muted-dark">Details</Text>
            <Text className="text-[15px] font-semibold text-accent dark:text-accent-dark">{open ? 'Hide' : 'Show'}</Text>
          </Pressable>
          {open ? extra.map((r, i) => <Line key={r.label} r={r} last={i === extra.length - 1} />) : null}
        </>
      ) : null}
    </View>
  );
}

function Line({ r, last }: { r: Detail; last: boolean }) {
  return (
    <View
      accessible
      accessibilityLabel={`${r.label}: ${r.value}`}
      className={`min-h-[44px] flex-row items-center justify-between gap-3 px-4 py-3 ${last ? '' : 'border-b border-line dark:border-line-dark'}`}>
      <Text className="text-[13px] text-muted dark:text-muted-dark">{r.label}</Text>
      <Text
        selectable={r.mono}
        style={r.mono ? { fontFamily: 'monospace' } : undefined}
        className={`flex-1 text-right text-ink dark:text-ink-dark ${r.mono ? 'text-[13px]' : r.strong ? 'text-[15px] font-bold' : 'text-[15px] font-semibold'}`}>
        {r.value}
      </Text>
    </View>
  );
}
