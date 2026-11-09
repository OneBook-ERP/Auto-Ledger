import { Switch, Text, useColorScheme, View } from 'react-native';

// accent / muted / surface tokens (tailwind.config.js); Switch colours cannot take class names.
const TRACK = { light: { on: '#2447D1', off: '#8793A5', thumb: '#FFFFFF' }, dark: { on: '#8EA6FF', off: '#586579', thumb: '#EDF1F8' } };

/** An on/off setting with its explanation; the whole row is one labelled switch. */
export function ToggleRow({ title, subtitle, value, onChange, testID, disabled }: {
  title: string; subtitle?: string; value: boolean; onChange: (v: boolean) => void; testID?: string; disabled?: boolean;
}) {
  const c = TRACK[useColorScheme() === 'dark' ? 'dark' : 'light'];
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
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityHint={subtitle}
        accessibilityState={{ checked: value, disabled: !!disabled }}
        trackColor={{ true: c.on, false: c.off }}
        thumbColor={c.thumb}
        style={{ minHeight: 48 }}
      />
    </View>
  );
}
