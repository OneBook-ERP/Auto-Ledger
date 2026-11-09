import { ArrowDownLeft, ArrowUpRight, Clock3, CreditCard, Home, Inbox, Landmark, ListFilter, Search, SlidersHorizontal, Smartphone, type LucideIcon } from 'lucide-react-native';

/** The icon set of the app (Lucide). Add a name here before using it; screens never import the library directly. */
export const ICONS = {
  home: Home,
  inbox: Inbox,
  activity: Clock3,
  settings: SlidersHorizontal,
  moneyIn: ArrowDownLeft,
  moneyOut: ArrowUpRight,
  card: CreditCard,
  bank: Landmark,
  upi: Smartphone,
  search: Search,
  filter: ListFilter,
} as const satisfies Record<string, LucideIcon>;
export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 22, color, strokeWidth = 2 }: { name: IconName; size?: number; color: string; strokeWidth?: number }) {
  const C = ICONS[name];
  return <C size={size} color={color} strokeWidth={strokeWidth} accessibilityElementsHidden importantForAccessibility="no" />;
}
