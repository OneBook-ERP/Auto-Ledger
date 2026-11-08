import { Redirect } from 'expo-router';
import { gateTarget } from '../src/state/gate';
import { useUiStore } from '../src/state/store';

/** Redirect gate: login -> setup wizard -> tabs. Renders nothing until the saved session has been read. */
export default function Index() {
  const boot = useUiStore((s) => s.boot);
  const signedIn = useUiStore((s) => s.session !== null);
  const setupDone = useUiStore((s) => s.setupDone);
  if (boot !== 'ready') return null;
  return <Redirect href={gateTarget({ signedIn, setupDone })} />;
}
