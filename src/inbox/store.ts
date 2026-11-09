// The answers given so far for each txn while the user moves through the flow screens (memory only:
// nothing is sent until "Create draft"), plus a one-off notice for the Inbox.
import { create } from 'zustand';
import type { FlowDraft } from './flow';

type FlowState = {
  drafts: Record<string, FlowDraft>;
  /** Shown once at the top of the Inbox (e.g. "No connection. Your answer is saved..."). */
  flash: string | null;
  /** Txns whose answer is being sent right now (the flow screens show "Still sending..." and lock the answers). */
  sending: Record<string, boolean>;
  setSending(txnId: string, v: boolean): void;
  start(txnId: string, d: FlowDraft): void;
  patch(txnId: string, p: Partial<FlowDraft>): void;
  clear(txnId: string): void;
  setFlash(m: string | null): void;
};

export const useFlowStore = create<FlowState>((set) => ({
  drafts: {},
  flash: null,
  sending: {},
  setSending: (id, v) => set((s) => {
    const { [id]: _was, ...rest } = s.sending;
    return { sending: v ? { ...rest, [id]: true } : rest };
  }),
  start: (id, d) => set((s) => ({ drafts: { ...s.drafts, [id]: d } })),
  patch: (id, p) => set((s) => ({ drafts: { ...s.drafts, [id]: { ...s.drafts[id], ...p } } })),
  clear: (id) => set((s) => {
    const { [id]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  }),
  setFlash: (flash) => set({ flash }),
}));
