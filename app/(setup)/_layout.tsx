import { Redirect, Stack } from 'expo-router';
import { useUiStore } from '../../src/state/store';

export default function SetupLayout() {
  const boot = useUiStore((s) => s.boot);
  const signedIn = useUiStore((s) => s.session !== null);
  if (boot === 'ready' && !signedIn) return <Redirect href="/(auth)/login" />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
