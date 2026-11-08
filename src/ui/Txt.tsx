import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

const VARIANT = {
  title: 'text-[28px] font-bold leading-9 tracking-tight text-ink dark:text-ink-dark',
  hero: 'text-[38px] font-bold leading-[44px] tracking-tight text-ink dark:text-ink-dark',
  body: 'text-base leading-6 text-ink dark:text-ink-dark',
  strong: 'text-base font-semibold text-ink dark:text-ink-dark',
  muted: 'text-sm leading-5 text-muted dark:text-muted-dark',
  heading: 'text-lg font-bold text-ink dark:text-ink-dark',
  section: 'text-sm font-semibold text-muted dark:text-muted-dark',
  mono: 'text-sm text-ink dark:text-ink-dark',
  in: 'text-sm font-semibold text-ok dark:text-ok-dark',
  out: 'text-sm font-semibold text-muted dark:text-muted-dark',
} as const;

/** Text in one of the kit's roles. `header` marks a heading for screen readers. */
export function Txt({ children, variant = 'body', header, a11yLabel, testID, center }: {
  children: ReactNode; variant?: keyof typeof VARIANT; header?: boolean; a11yLabel?: string; testID?: string; center?: boolean;
}) {
  return (
    <Text testID={testID} style={variant === 'mono' ? { fontFamily: 'monospace' } : variant === 'hero' ? { fontVariant: ['tabular-nums'] } : undefined} accessibilityRole={header ? 'header' : undefined} accessibilityLabel={a11yLabel}
      className={`${VARIANT[variant]} ${center ? 'text-center' : ''}`}>
      {children}
    </Text>
  );
}

/** Vertical group with a fixed gap (in the 4 dp scale). */
export function Stack({ children, gap = 3 }: { children: ReactNode; gap?: 1 | 2 | 3 | 4 | 6 }) {
  const g = { 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4', 6: 'gap-6' }[gap];
  return <View className={g}>{children}</View>;
}

/** Horizontal group, items centred, wrapping when narrow. */
export function Row({ children, between }: { children: ReactNode; between?: boolean }) {
  return <View className={`flex-row flex-wrap items-center gap-2 ${between ? 'justify-between' : ''}`}>{children}</View>;
}

/** Vertical space between blocks (4 dp scale). */
export function Gap({ size = 4 }: { size?: 2 | 3 | 4 | 6 | 8 }) {
  const h = { 2: 'h-2', 3: 'h-3', 4: 'h-4', 6: 'h-6', 8: 'h-8' }[size];
  return <View className={h} />;
}
