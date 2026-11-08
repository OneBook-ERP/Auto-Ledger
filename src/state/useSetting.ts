import { useEffect, useState } from 'react';
import { useApp } from './AppProvider';

export const COMPANY_KEY = 'company';
export const DRAWINGS_KEY = 'drawingsAccount';
export const DEFAULT_EXPENSE_KEY = 'defaultExpenseAccount';

/** Reads one persisted setting once. `undefined` until loaded. */
export function useSetting(key: string): string | null | undefined {
  const { repo } = useApp();
  const [v, setV] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    repo.getSetting(key).then((x) => live && setV(x), () => live && setV(null));
    return () => {
      live = false;
    };
  }, [repo, key]);
  return v;
}
