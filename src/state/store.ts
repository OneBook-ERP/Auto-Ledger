import { create } from 'zustand';

/** What the UI may know about the signed-in session. Never the key, secret or password. */
export type SessionSummary = { siteUrl: string; user: string };

export type UiState = {
  boot: 'loading' | 'ready';
  session: SessionSummary | null;
  setupDone: boolean;
  /** Set when the outbox stopped because ERPNext rejected the saved credentials. */
  needsLogin: boolean;
  /** Set when the native SMS engine reports usable=false. */
  engineUnusable: boolean;
  /** Bumped after each cycle and its background step: screens holding local data (Inbox, Activity) re-read. */
  dataVersion: number;
  bumpData(): void;
  setBoot(p: { session: SessionSummary | null; setupDone: boolean }): void;
  setSession(s: SessionSummary | null): void;
  setSetupDone(v: boolean): void;
  setNeedsLogin(v: boolean): void;
  setEngineUnusable(v: boolean): void;
};

export const useUiStore = create<UiState>((set) => ({
  boot: 'loading',
  session: null,
  setupDone: false,
  needsLogin: false,
  engineUnusable: false,
  dataVersion: 0,
  bumpData: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
  setBoot: ({ session, setupDone }) => set({ boot: 'ready', session, setupDone }),
  setSession: (session) => set({ session }),
  setSetupDone: (setupDone) => set({ setupDone }),
  setNeedsLogin: (needsLogin) => set({ needsLogin }),
  setEngineUnusable: (engineUnusable) => set({ engineUnusable }),
}));
