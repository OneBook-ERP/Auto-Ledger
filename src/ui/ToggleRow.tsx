import { Switch, Text, View } from 'react-native';

/** An on/off setting with its explanation; the whole row is one labelled switch. */
export function ToggleRow({ title, subtitle, value, onChange, testID }: { title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; testID?: string }) {
  return (
    <View className="mb-4 min-h-[48px] flex-row items-center gap-3 px-1">
      <View className="flex-1">
        <Text className="text-[15px] font-semibold text-ink dark:text-ink-dark">{title}</Text>
        {subtitle ? <Text className="mt-0.5 text-[13px] leading-[18px] text-muted dark:text-muted-dark">{subtitle}</Text> : null}
      </View>
      <Switch
        testID={testID}
        value={value}
        onValueChange={onChange}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityState={{ checked: value }}
        trackColor={{ true: '#2447D1', false: '#97A5BA' }}
        thumbColor="#FFFFFF"
        style={{ minHeight: 48 }}
      />
    </View>
  );
}
