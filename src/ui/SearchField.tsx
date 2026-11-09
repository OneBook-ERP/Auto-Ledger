import { Pressable, Text, TextInput, useColorScheme, View } from 'react-native';
import { Icon } from './Icon';

export interface SearchFieldProps {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  testID?: string;
}

/** Search box, 52 dp tall, with a Clear button once something is typed. */
export function SearchField({ value, onChange, placeholder = 'Search', testID }: SearchFieldProps) {
  const dark = useColorScheme() === 'dark';
  return (
    <View className="mb-3 min-h-[52px] flex-row items-center rounded-xl border border-line bg-surface px-3 dark:border-line-dark dark:bg-surface-dark">
      <Icon name="search" size={18} color={dark ? '#97A5BA' : '#586579'} />
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={dark ? '#6B7A91' : '#8793A5'}
        accessibilityLabel={placeholder}
        autoCorrect={false}
        autoCapitalize="none"
        returnKeyType="search"
        className="ml-2 min-h-[48px] flex-1 py-2 text-base text-ink dark:text-ink-dark"
      />
      {value ? (
        <Pressable onPress={() => onChange('')} accessibilityRole="button" accessibilityLabel="Clear search" className="min-h-[48px] min-w-[48px] items-center justify-center">
          <Text className="text-sm font-semibold text-accent dark:text-accent-dark">Clear</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
