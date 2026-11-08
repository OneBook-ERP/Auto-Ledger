import { ErpClient } from '../erp/client';
import { buildErp } from './erp';

const S = { siteUrl: 'https://x.example', apiKey: 'k', apiSecret: 's', user: 'u', roles: [] };
const reply = (status: number, body: unknown) => jest.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('buildErp', () => {
  it('wires checkSession to frappe.auth.get_logged_user', async () => {
    const f = reply(200, { message: 'u' });
    const { erp, client } = buildErp(S, { fetchImpl: f });
    expect(client).toBeInstanceOf(ErpClient);
    expect(await erp.checkSession()).toBe(true);
    expect((f as jest.Mock).mock.calls[0][0]).toBe('https://x.example/api/method/frappe.auth.get_logged_user');
  });
  it('checkSession is false on 401/403 and throws on network failure', async () => {
    expect(await buildErp(S, { fetchImpl: reply(401, { exc_type: 'AuthenticationError' }) }).erp.checkSession()).toBe(false);
    const down = jest.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    await expect(buildErp(S, { fetchImpl: down }).erp.checkSession()).rejects.toBeTruthy();
  });
});
