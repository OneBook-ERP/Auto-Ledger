import { Redirect, Tabs } from 'expo-router';
import { useContext, useEffect, useState } from 'react';
import { useColorScheme, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../../src/ui';
import { AppContext } from '../../src/state/AppProvider';
import { AppBanners } from '../../src/state/AppBanners';
import { gateTarget } from '../../src/state/gate';
import { useUiStore } from '../../src/state/store';

/** Tab bar content height (icon 24 + label + padding); the real bottom inset is added on top. */
export const TAB_BAR_CONTENT = 64;
const POLL_MS = 15_000;

/** How many transactions wait for an answer (same source as the Inbox). 0 outside the app provider or on any error. */
export function usePendingCount(): number {
  const app = useContext(AppContext);
  const repo = app?.repo;
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    const read = () => repo.countPending('new').then((count) => live && setN(count), () => undefined);
    void read();
    const id = setInterval(read, POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [repo]);
  return n;
}

const tabIcon = (name: IconName) =>
  function TabIcon({ color, focused }: { color: unknown; focused: boolean }) {
    return <Icon name={name} size={24} color={String(color)} strokeWidth={focused ? 2.4 : 1.8} />;
  };

export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const pending = usePendingCount();
  const dark = useColorScheme() === 'dark';
  const boot = useUiStore((s) => s.boot);
  const signedIn = useUiStore((s) => s.session !== null);
  const setupDone = useUiStore((s) => s.setupDone);
  if (boot !== 'ready') return null;
  const target = gateTarget({ signedIn, setupDone });
  if (target !== '/(tabs)/home') return <Redirect href={target} />;
  return (
    <View className="flex-1 bg-paper dark:bg-paper-dark">
      <AppBanners />
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: dark ? '#8EA6FF' : '#2447D1',
          tabBarInactiveTintColor: dark ? '#97A5BA' : '#586579',
          tabBarStyle: { backgroundColor: dark ? '#141C2C' : '#FFFFFF', borderTopColor: dark ? '#243049' : '#DCE2EA', height: TAB_BAR_CONTENT + Math.max(insets.bottom, 12), paddingTop: 6, paddingBottom: Math.max(insets.bottom, 12) },
          tabBarLabelStyle: { fontSize: 12, fontWeight: '600', marginTop: 2 },
          tabBarAllowFontScaling: false,
          tabBarBadgeStyle: { minWidth: 18, height: 18, fontSize: 11, lineHeight: 16, top: -2 },
        }}>
        <Tabs.Screen name="home" options={{ title: 'Home', tabBarIcon: tabIcon('home') }} />
        <Tabs.Screen name="inbox" options={{ title: 'Inbox', tabBarIcon: tabIcon('inbox'), tabBarBadge: pending > 0 ? (pending > 99 ? '99+' : pending) : undefined }} />
        <Tabs.Screen name="activity" options={{ title: 'Activity', tabBarIcon: tabIcon('activity') }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings', tabBarIcon: tabIcon('settings') }} />
      </Tabs>
    </View>
  );
}
