import '../global.css';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider } from '../src/state/AppProvider';
import { initCrashReporting } from '../src/state/sentry';

// Crash reporting is OFF unless the build sets EXPO_PUBLIC_SENTRY_DSN (empty by default). Read literally here
// so Expo inlines it at build time.
const SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN;
if (typeof SENTRY_DSN === 'string' && SENTRY_DSN.trim() !== '') initCrashReporting(SENTRY_DSN);

export default function RootLayout() {
  return (
    <AppProvider>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </AppProvider>
  );
}
