// Navigation double-tap guard: a second tap within the window (two fast taps on a row) is dropped, so one
// tap pushes one screen. Pure; the clock is injected.
export const TAP_WINDOW_MS = 800;

export function createTapGuard(now: () => number, windowMs = TAP_WINDOW_MS) {
  let last = -Infinity;
  return (fn: () => void) => {
    const t = now();
    if (t - last < windowMs) return false;
    last = t;
    fn();
    return true;
  };
}
