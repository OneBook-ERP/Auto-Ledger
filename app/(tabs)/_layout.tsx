import { Redirect, Tabs } from 'expo-router';
import { useColorScheme, View } from 'react-native';
import { AppBanners } from '../../src/state/AppBanners';
import { gateTarget } from '../../src/state/gate';
import { useUiStore } from '../../src/state/store';

export default function TabsLayout() {
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
          tabBarStyle: { backgroundColor: dark ? '#141C2C' : '#FFFFFF', borderTopColor: dark ? '#243049' : '#DCE2EA', height: 64 },
          tabBarLabelStyle: { fontSize: 14, fontWeight: '600', paddingBottom: 10 },
          tabBarIconStyle: { display: 'none' },
        }}>
        <Tabs.Screen name="home" options={{ title: 'Home' }} />
        <Tabs.Screen name="inbox" options={{ title: 'Inbox' }} />
        <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </View>
  );
}
