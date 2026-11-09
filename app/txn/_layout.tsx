import { Redirect, Stack } from 'expo-router';
import { gateTarget } from '../../src/state/gate';
import { useUiStore } from '../../src/state/store';

/** The answer flow (transaction, steps, confirm, result) sits behind the same gate as the tabs. */
export default function TxnLayout() {
  const boot = useUiStore((s) => s.boot);
  const signedIn = useUiStore((s) => s.session !== null);
  const setupDone = useUiStore((s) => s.setupDone);
  if (boot !== 'ready') return null;
  const target = gateTarget({ signedIn, setupDone });
  if (target !== '/(tabs)/home') return <Redirect href={target} />;
  return <Stack screenOptions={{ headerShown: false }} />;
}
