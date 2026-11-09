import type { ReactNode } from 'react';
import { KeyboardAvoidingView, RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export interface ScreenProps {
  title?: string;
  subtitle?: string;
  /** Rendered above the title (e.g. StepHeader, banners). */
  top?: ReactNode;
  children?: ReactNode;
  /** Pinned bottom area: one primary action per screen. */
  footer?: ReactNode;
  scroll?: boolean;
  /** Pull-to-refresh (scrolling screens only). */
  refresh?: { refreshing: boolean; onRefresh: () => void };
  /** Same thing as `refresh`, as two flat props (used by Activity). `refresh` wins when both are given. */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** Page frame: safe area, calm paper background, 20 dp gutters, optional pinned footer action. */
export function Screen({ title, subtitle, top, children, footer, scroll = true, refresh, onRefresh, refreshing = false }: ScreenProps) {
  const pull = refresh ?? (onRefresh ? { refreshing, onRefresh } : undefined);
  const body = (
    <>
      {top}
      {title ? (
        <Text accessibilityRole="header" className="mt-2 text-[28px] font-bold leading-9 tracking-tight text-ink dark:text-ink-dark">
          {title}
        </Text>
      ) : null}
      {subtitle ? <Text className="mt-2 text-base leading-6 text-muted dark:text-muted-dark">{subtitle}</Text> : null}
      {/* In a non-scrolling Screen the children (e.g. a RefreshScroll list) must be able to fill the height. */}
      <View className={`${scroll ? '' : 'flex-1 '}${title || subtitle ? 'mt-6' : ''}`.trim()}>{children}</View>
    </>
  );
  return (
    <SafeAreaView className="flex-1 bg-paper dark:bg-paper-dark" edges={['top', 'left', 'right']}>
      {/* SDK 58 Android is edge-to-edge: the window no longer resizes for the keyboard, so pad it here. */}
      <KeyboardAvoidingView testID="screen-keyboard-avoiding" behavior="padding" className="flex-1">
        {scroll ? (
          <ScrollView testID="screen-scroll" className="flex-1" contentContainerClassName="px-5 pb-8 pt-4" keyboardShouldPersistTaps="handled"
            refreshControl={pull ? <RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} /> : undefined}>
            {body}
          </ScrollView>
        ) : (
          <View className="flex-1 px-5 pb-4 pt-4">{body}</View>
        )}
        {footer ? <View className="border-t border-line bg-surface px-5 pb-5 pt-3 dark:border-line-dark dark:bg-surface-dark">{footer}</View> : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
