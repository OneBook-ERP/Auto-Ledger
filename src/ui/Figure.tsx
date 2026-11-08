import { Text, View } from 'react-native';

/** A labelled figure: tabular numerals, announced as one unit ("Bank balance ₹5,12,932.76"). Unknown is "—". */
export function Figure({ label, value, caption, size = 'lg', testID }: { label: string; value: string; caption?: string; size?: 'md' | 'lg' | 'xl'; testID?: string }) {
  const cls = size === 'xl' ? 'text-4xl' : size === 'lg' ? 'text-2xl' : 'text-lg';
  const spoken = value === '—' ? 'not available' : value;
  return (
    <View testID={testID} accessible accessibilityLabel={`${label} ${spoken}${caption ? `, ${caption}` : ''}`}>
      <Text className="text-sm font-medium text-muted dark:text-muted-dark">{label}</Text>
      <Text style={{ fontVariant: ['tabular-nums'] }} className={`mt-1 ${cls} font-semibold tracking-tight text-ink dark:text-ink-dark`}>
        {value}
      </Text>
      {caption ? <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{caption}</Text> : null}
    </View>
  );
}
