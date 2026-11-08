import { useState, type ReactNode } from 'react';
import { Pressable, Text, TextInput, useColorScheme, View, type TextInputProps } from 'react-native';

export interface TextFieldProps extends Omit<TextInputProps, 'style' | 'secureTextEntry'> {
  label: string;
  hint?: string;
  error?: string;
  /** Password-style field with a Show/Hide toggle. */
  secret?: boolean;
  right?: ReactNode;
}

/** Labelled input, 52 dp tall. Labels are real accessibility labels; errors are announced. */
export function TextField({ label, hint, error, secret, right, ...input }: TextFieldProps) {
  const [shown, setShown] = useState(false);
  const dark = useColorScheme() === 'dark';
  return (
    <View className="mb-4">
      <Text className="mb-1.5 text-sm font-medium text-ink dark:text-ink-dark">{label}</Text>
      <View
        className={`min-h-[52px] flex-row items-center rounded-xl border bg-surface px-4 dark:bg-surface-dark ${
          error ? 'border-danger dark:border-danger-dark' : 'border-line dark:border-line-dark'
        }`}>
        <TextInput
          accessibilityLabel={label}
          accessibilityHint={error ? (hint ? `${error} ${hint}` : error) : hint}
          placeholderTextColor={dark ? '#6B7A91' : '#8793A5'}
          secureTextEntry={secret && !shown}
          className="min-h-[48px] flex-1 py-2 text-base text-ink dark:text-ink-dark"
          {...input}
        />
        {secret ? (
          <Pressable
            onPress={() => setShown((s) => !s)}
            accessibilityRole="button"
            accessibilityLabel={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
            className="min-h-[48px] min-w-[48px] items-center justify-center">
            <Text className="text-sm font-semibold text-accent dark:text-accent-dark">{shown ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : (
          right
        )}
      </View>
      {error ? (
        <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" className="mt-1.5 text-sm text-danger dark:text-danger-dark">
          {error}
        </Text>
      ) : hint ? (
        <Text className="mt-1.5 text-sm text-muted dark:text-muted-dark">{hint}</Text>
      ) : null}
    </View>
  );
}
