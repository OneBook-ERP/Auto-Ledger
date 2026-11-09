import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { ActivitySort } from '../state/activityModel';
import { Button } from './Button';
import { Chip } from './Chip';

export type ActivityFilters = { direction?: 'in' | 'out'; accountLast4?: string; sort: ActivitySort };
export const DEFAULT_FILTERS: ActivityFilters = { sort: 'newest' };

/** How many of the three settings differ from the defaults (shown on the Filters button). */
export const activeFilterCount = (f: ActivityFilters) => (f.direction ? 1 : 0) + (f.accountLast4 ? 1 : 0) + (f.sort !== 'newest' ? 1 : 0);

const SORTS: { key: ActivitySort; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'oldest', label: 'Oldest first' },
  { key: 'amount_high', label: 'Highest amount' },
  { key: 'amount_low', label: 'Lowest amount' },
  { key: 'name_az', label: 'Name A to Z' },
];

export interface FilterSheetProps {
  visible: boolean;
  value: ActivityFilters;
  /** Last four digits of each account that appears in the list. */
  accounts: string[];
  onApply: (f: ActivityFilters) => void;
  onReset: () => void;
  onClose: () => void;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-2">
      <Text accessibilityRole="header" className="mb-2 mt-3 text-sm font-semibold text-muted dark:text-muted-dark">{title}</Text>
      <View className="flex-row flex-wrap">{children}</View>
    </View>
  );
}

/** Bottom sheet: money direction, account and sort order. Nothing changes until Apply. */
export function FilterSheet({ visible, value, accounts, onApply, onReset, onClose }: FilterSheetProps) {
  const [draft, setDraft] = useState<ActivityFilters>(value);
  const [wasVisible, setWasVisible] = useState(false);
  // Start from what is applied every time the sheet opens.
  if (visible && !wasVisible) {
    setWasVisible(true);
    setDraft(value);
  } else if (!visible && wasVisible) setWasVisible(false);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close filters" accessibilityRole="button" onPress={onClose} className="flex-1 bg-black/40" />
      <View testID="filter-sheet" className="max-h-[80%] rounded-t-3xl bg-surface px-4 pb-6 pt-4 dark:bg-surface-dark">
        <Text accessibilityRole="header" className="text-xl font-semibold text-ink dark:text-ink-dark">Filters</Text>
        <ScrollView>
          <Group title="Money">
            <Chip label="All" selected={!draft.direction} onPress={() => setDraft({ ...draft, direction: undefined })} />
            <Chip label="Money in" selected={draft.direction === 'in'} onPress={() => setDraft({ ...draft, direction: 'in' })} />
            <Chip label="Money out" selected={draft.direction === 'out'} onPress={() => setDraft({ ...draft, direction: 'out' })} />
          </Group>
          {accounts.length > 1 ? (
            <Group title="Account">
              <Chip label="All accounts" selected={!draft.accountLast4} onPress={() => setDraft({ ...draft, accountLast4: undefined })} />
              {accounts.map((a) => (
                <Chip key={a} label={`Account ending ${a}`} selected={draft.accountLast4 === a} onPress={() => setDraft({ ...draft, accountLast4: a })} />
              ))}
            </Group>
          ) : null}
          <Group title="Sort by">
            {SORTS.map((s) => (
              <Chip key={s.key} label={s.label} selected={draft.sort === s.key} onPress={() => setDraft({ ...draft, sort: s.key })} />
            ))}
          </Group>
        </ScrollView>
        <View className="mt-2 flex-row gap-3">
          <View className="flex-1"><Button variant="secondary" label="Reset" onPress={onReset} /></View>
          <View className="flex-1"><Button label="Apply" onPress={() => onApply(draft)} /></View>
        </View>
      </View>
    </Modal>
  );
}
