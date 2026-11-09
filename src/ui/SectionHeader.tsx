import { Text } from 'react-native';

/** Heading of a list section (screen readers can jump between headings). */
export function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <Text accessibilityRole="header" className="mb-2 mt-4 text-sm font-semibold text-muted dark:text-muted-dark">
      {count === undefined ? title : `${title} (${count})`}
    </Text>
  );
}
