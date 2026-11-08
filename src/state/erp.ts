import type { Session } from '../erp/auth';
import { ErpAuthError, ErpClient } from '../erp/client';
import type { DrainErp } from '../ingest/drain';
import { makeErpOps } from '../outbox/erpOps';

/** ErpClient + the ops the outbox needs, built from the stored Session. checkSession is the cheap authenticated call. */
export function buildErp(s: Session, opts: { fetchImpl?: typeof fetch } = {}): { client: ErpClient; erp: DrainErp } {
  const client = new ErpClient({ siteUrl: s.siteUrl, apiKey: s.apiKey, apiSecret: s.apiSecret, allowHttp: __DEV__, fetchImpl: opts.fetchImpl });
  const erp: DrainErp = {
    ...makeErpOps(client),
    async checkSession() {
      try {
        await client.get('/api/method/frappe.auth.get_logged_user');
        return true;
      } catch (e) {
        if (e instanceof ErpAuthError) return false;
        throw e;
      }
    },
  };
  return { client, erp };
}
