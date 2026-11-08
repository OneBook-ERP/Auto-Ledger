import { ErpAuthError, ErpClient, ErpValidationError } from '../erp/client';
import { makeErpOps } from './erpOps';

type Reply = { status?: number; body?: unknown };

function setup(...replies: Reply[]) {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method as string, body: init.body ? JSON.parse(init.body as string) : undefined });
    const r = replies[Math.min(i++, replies.length - 1)];
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { ops: makeErpOps(new ErpClient({ siteUrl: 'https://x.example', apiKey: 'k', apiSecret: 's', fetchImpl: impl })), calls };
}

describe('makeErpOps', () => {
  it('findDraftByUtr delegates (Payment Entry then Journal Entry)', async () => {
    const { ops, calls } = setup({ body: { data: [] } }, { body: { data: [{ name: 'JV-1', docstatus: 0 }] } });
    expect(await ops.findDraftByUtr('UTR1')).toEqual({ doctype: 'Journal Entry', name: 'JV-1', docstatus: 0 });
    expect(calls.map((c) => decodeURIComponent(c.url.split('?')[0]))).toEqual([
      'https://x.example/api/resource/Payment Entry',
      'https://x.example/api/resource/Journal Entry',
    ]);
  });

  it('createDraft posts a draft (docstatus forced to 0)', async () => {
    const { ops, calls } = setup({ body: { data: { name: 'PE-1' } } });
    expect(await ops.createDraft('Payment Entry', { reference_no: 'U', docstatus: 1 })).toEqual({ name: 'PE-1' });
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ reference_no: 'U', docstatus: 0 });
  });

  it('createDraft refuses doctypes other than Payment Entry / Journal Entry without calling the server', async () => {
    const { ops, calls } = setup({ body: { data: { name: 'X' } } });
    await expect(ops.createDraft('Sales Invoice', {})).rejects.toBeInstanceOf(ErpValidationError);
    expect(calls).toHaveLength(0);
  });

  it('deleteDraft reads the status then deletes', async () => {
    const { ops, calls } = setup({ body: { data: { docstatus: 0 } } }, { status: 202, body: { data: 'ok' } });
    await ops.deleteDraft('Payment Entry', 'PE/1');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'DELETE']);
    expect(calls[1].url).toBe('https://x.example/api/resource/Payment%20Entry/PE%2F1');
  });

  it('searchParties and createParty delegate', async () => {
    const { ops } = setup({ body: { data: [{ name: 'Acme', customer_name: 'Acme Ltd' }] } }, { body: { data: { name: 'Acme' } } });
    expect(await ops.searchParties('Customer', 'Acme')).toEqual([{ doctype: 'Customer', name: 'Acme', displayName: 'Acme Ltd' }]);
    expect(await ops.createParty('Customer', { customer_name: 'Acme' })).toEqual({ doctype: 'Customer', name: 'Acme' });
  });

  it('passes ERP error classes through unchanged', async () => {
    const { ops } = setup({ status: 401, body: { exc_type: 'AuthenticationError' } });
    await expect(ops.findDraftByUtr('U')).rejects.toBeInstanceOf(ErpAuthError);
  });
});
