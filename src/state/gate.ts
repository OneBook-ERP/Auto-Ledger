export type GateTarget = '/(auth)/login' | '/(setup)/company' | '/(tabs)/home';

/** Where the app opens: sign in first, then the setup wizard, then the main tabs. */
export function gateTarget(s: { signedIn: boolean; setupDone: boolean }): GateTarget {
  if (!s.signedIn) return '/(auth)/login';
  return s.setupDone ? '/(tabs)/home' : '/(setup)/company';
}
