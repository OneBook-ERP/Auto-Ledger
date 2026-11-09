import { Pressable, Text, View } from 'react-native';

export interface BannerProps {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  /** One or two lines: tight padding, actions inline. */
  compact?: boolean;
  secondaryLabel?: string;
  onSecondary?: () => void;
  testID?: string;
}

const BOX = {
  info: 'bg-accent-soft dark:bg-accent-soft-dark',
  warn: 'bg-warn-soft dark:bg-warn-soft-dark',
  error: 'bg-danger-soft dark:bg-danger-soft-dark',
  ok: 'bg-ok-soft dark:bg-ok-soft-dark',
} as const;
const TITLE = {
  info: 'text-accent dark:text-accent-dark',
  warn: 'text-warn dark:text-warn-dark',
  error: 'text-danger dark:text-danger-dark',
  ok: 'text-ok dark:text-ok-dark',
} as const;

/** Inline notice. Errors and warnings are announced to screen readers. */
export function Banner({ tone = 'info', title, message, actionLabel, onAction, compact, secondaryLabel, onSecondary, testID }: BannerProps) {
  if (compact) {
    return (
      <View
        testID={testID}
        accessibilityRole={tone === 'error' || tone === 'warn' ? 'alert' : undefined}
        accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
        className={`mb-3 flex-row flex-wrap items-center rounded-xl px-4 py-1 ${BOX[tone]}`}>
        <Text className="mr-3 min-w-[60%] flex-1 py-2 text-[14px] leading-5 text-ink dark:text-ink-dark">{message}</Text>
        {actionLabel && onAction ? (
          <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={actionLabel} className="min-h-[48px] justify-center pr-3">
            <Text className={`text-[14px] font-semibold ${TITLE[tone]}`}>{actionLabel}</Text>
          </Pressable>
        ) : null}
        {secondaryLabel && onSecondary ? (
          <Pressable onPress={onSecondary} accessibilityRole="button" accessibilityLabel={secondaryLabel} className="min-h-[48px] justify-center">
            <Text className="text-[14px] font-semibold text-muted dark:text-muted-dark">{secondaryLabel}</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'error' || tone === 'warn' ? 'alert' : undefined}
      // accessibilityRole="alert" creates no live region on Android: set one explicitly.
      accessibilityLiveRegion={tone === 'error' ? 'assertive' : 'polite'}
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
