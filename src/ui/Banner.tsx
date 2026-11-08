import { Pressable, Text, View } from 'react-native';

export interface BannerProps {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}

const BOX = {
  info: 'bg-accent-soft dark:bg-accent-soft-dark',
  warn: 'bg-warn-soft dark:bg-warn-soft-dark',
  error: 'bg-danger-soft dark:bg-danger-soft-dark',
  ok: 'bg-ok-soft dark:bg-ok-soft-dark',
} as const;
const TITLE = { info: 'text-accent dark:text-accent-dark', warn: 'text-warn', error: 'text-danger', ok: 'text-ok' } as const;

/** Inline notice. Errors and warnings are announced to screen readers. */
export function Banner({ tone = 'info', title, message, actionLabel, onAction, testID }: BannerProps) {
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'error' || tone === 'warn' ? 'alert' : undefined}
      className={`mb-4 rounded-xl px-4 py-3 ${BOX[tone]}`}>
      {title ? <Text className={`text-base font-semibold ${TITLE[tone]}`}>{title}</Text> : null}
      <Text className="mt-0.5 text-[15px] leading-[22px] text-ink dark:text-ink-dark">{message}</Text>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          className="mt-1 min-h-[48px] justify-center self-start">
          <Text className={`text-base font-semibold ${TITLE[tone]}`}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
