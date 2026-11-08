import { useMemo } from 'react';
import { makeErpOps, type ErpOps } from '../outbox/erpOps';
import { useApp } from './AppProvider';

/** ERPNext document operations bound to the signed-in client, or null while signed out. */
export function useErpOps(): ErpOps | null {
  const { client } = useApp();
  return useMemo(() => (client ? makeErpOps(client) : null), [client]);
}
