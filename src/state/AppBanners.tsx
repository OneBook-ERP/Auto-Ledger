import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Banner } from '../ui';
import { useUiStore } from './store';

export const SIGN_IN_AGAIN = 'Sign in again';
export const ENGINE_UNAVAILABLE = 'SMS reading is unavailable, update the app';

/** App-wide notices shown above the tabs: expired login (data kept) and an unusable SMS engine. */
export function AppBanners() {
  const router = useRouter();
  const needsLogin = useUiStore((s) => s.needsLogin);
  const engineUnusable = useUiStore((s) => s.engineUnusable);
  if (!needsLogin && !engineUnusable) return null;
  return (
    <SafeAreaView edges={['top']} className="bg-paper px-5 pt-3 dark:bg-paper-dark">
      <View>
        {engineUnusable ? (
          <Banner tone="error" testID="engine-banner" title={ENGINE_UNAVAILABLE} message="New bank messages cannot be read until the app is updated. Entries you already have are safe." />
        ) : null}
        {needsLogin ? (
          <Banner
            tone="warn"
            testID="login-banner"
            title={SIGN_IN_AGAIN}
            message="ERPNext no longer accepts the saved login, so entries are waiting on this phone. Everything stays here until you sign in."
            actionLabel={SIGN_IN_AGAIN}
            onAction={() => router.push('/(auth)/login')}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}
