/** @jest-environment node */
// Runs against the STAGE site only, and only when the three ONEBOOK_STAGE_* variables are set.
// NEVER point this at production.
import https from 'https';
import { ErpClient, encodeSegment } from './client';
import {
  NotDraftError,
  createDraft,
  deleteDraft,
  findDraftByUtr,
  getBankBalance,
  getDocStatuses,
  getReceivablesPayables,
  listBankAccounts,
  listCompanies,
  listLedgerAccounts,
} from './docs';

const { ONEBOOK_STAGE_URL: URL_, ONEBOOK_STAGE_KEY: KEY, ONEBOOK_STAGE_SECRET: SECRET } = process.env;
// The jest-expo preset replaces global fetch with a stub that has no real network behaviour, so the stage
// test talks through node's https module instead. ErpClient only uses `status` and `text()`.
const nodeFetch = ((url: string, init: RequestInit) =>
  new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method, headers: init.headers as Record<string, string> }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d: Buffer) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (init.body) req.write(init.body as string);
    req.end();
  })) as unknown as typeof fetch;

const enabled = !!(URL_ && KEY && SECRET);
const stageOnly = URL_ ? /^https:\/\/stageatom\.onebook\.app\/?$/.test(URL_) : true;

(enabled ? describe : describe.skip)('ERPNext docs against STAGE', () => {
  const c = enabled && stageOnly ? new ErpClient({ siteUrl: URL_ as string, apiKey: KEY as string, apiSecret: SECRET as string, fetchImpl: nodeFetch }) : (undefined as unknown as ErpClient);
  const created: string[] = [];
  const utr = `ZZT11${Date.now().toString(36).toUpperCase()}`;
  const today = new Date().toISOString().slice(0, 10);

  it('refuses anything but the stage site', () => {
    expect(stageOnly).toBe(true);
  });

  afterAll(async () => {
    if (!c) return;
    for (const name of created) {
      try {
        await c.delete(`/api/resource/${encodeSegment('Journal Entry')}/${encodeSegment(name)}`);
      } catch {
        /* already gone */
      }
    }
    // Sweep by tag in case something slipped through.
    try {
      const left = await findDraftByUtr(c, utr);
      if (left) await c.delete(`/api/resource/${encodeSegment(left.doctype)}/${encodeSegment(left.name)}`);
    } catch {
      /* best effort */
    }
  });

  it('create draft JE with UTR, find, status, in-filter, delete', async () => {
    const companies = await listCompanies(c);
    expect(companies.length).toBeGreaterThan(0);
    const company = companies[0].name;
    try {
      const { name } = await createDraft(c, 'Journal Entry', {
        company,
        posting_date: today,
        voucher_type: 'Journal Entry',
        cheque_no: utr,
        cheque_date: today,
        user_remark: 'AutoLedger task 11 stage test (safe to delete)',
        accounts: [
          { account: 'Miscellaneous Expenses - ZP', debit_in_account_currency: 1 },
          { account: 'IDFC Credit Card - ZP', credit_in_account_currency: 1 },
        ],
      });
      created.push(name);

      expect(await findDraftByUtr(c, utr)).toEqual({ doctype: 'Journal Entry', name, docstatus: 0 });

      // exercises the `in` filter; the nonexistent name must simply be absent
      const st = await getDocStatuses(c, [
        { doctype: 'Journal Entry', name },
        { doctype: 'Journal Entry', name: 'ACC-JV-DOES-NOT-EXIST' },
      ]);
      expect(st).toEqual({ [`Journal Entry:${name}`]: 0 });

      await deleteDraft(c, 'Journal Entry', name);
      created.length = 0;
      expect(await findDraftByUtr(c, utr)).toBeNull();
      expect(NotDraftError).toBeDefined();
    } finally {
      /* afterAll sweeps */
    }
  });

  it('reads bank balance, AR/AP, accounts', async () => {
    const company = (await listCompanies(c))[0].name;
    const bal = await getBankBalance(c, 'IDFC First - ZP', company);
    expect(Number.isInteger(bal)).toBe(true);
    const ap = await getReceivablesPayables(c, company);
    expect(Number.isInteger(ap.receivableMinor)).toBe(true);
    expect(Number.isInteger(ap.payableMinor)).toBe(true);
    const banks = await listBankAccounts(c, company);
    const exp = await listLedgerAccounts(c, company, { rootType: 'Expense' });
    expect(exp.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ company, balanceMinor: bal, ...ap, bankAccounts: banks.length, expenseAccounts: exp.length }));
  });
});
