import type { BookedEntry } from '../core/similar';
import type { PendingTxn } from '../core/types';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { ErpNetworkError } from '../erp/client';
import { COMPANY_KEY } from '../state/useSetting';
import { ErpClient } from '../erp/client';
import { COMPANY_SETTING, DUP_KEY_PREFIX, dupCheckWith, dupKey, parseDupFlag, runDupCheck } from './dupCheck';

jest.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));

const txn = (id: string, over: Partial<PendingTxn> = {}): PendingTxn => ({
  id, mergedCount: 1, state: 'new', createdDocs: [], error: null,
  kind: 'card_spend', direction: 'out', amountMinor: 50000, currency: 'INR',
  occurredOn: '2026-11-08', occurredTime: null, accountType: 'card', accountLast4: '1234',
  counterparty: null, utr: null, merchant: 'HP Fuel', balanceMinor: null,
  sender: 'AX-IDFCFB', receivedAt: 1, rawHash: `h${id}`, ...over,
});

const entry = (over: Partial<BookedEntry> = {}): BookedEntry => ({
  doctype: 'Payment Entry', name: 'PE-1', postingDate: '2026-11-08', amountMinor: 50000,
  direction: 'out', party: 'HP Fuel', reference: null, docstatus: 0, ...over,
});

async function setup(txns: PendingTxn[], entries: BookedEntry[] | Error = [], company: string | null = 'ZP') {
  const repo: Repo = await createRepo(createTestDriver());
  for (const t of txns) await repo.upsertPending(t);
  if (company) await repo.setSetting(COMPANY_SETTING, company);
  const listBookedEntries = jest.fn(async (_company: string, _from: string, _to: string) => {
    if (entries instanceof Error) throw entries;
    return entries;
  });
  return { repo, listBookedEntries, deps: { repo, erp: { listBookedEntries } } };
}

const flag = async (repo: Repo, id: string) => parseDupFlag(await repo.getSetting(dupKey(id)));

describe('runDupCheck', () => {
  it('uses the same company setting as the rest of the app', () => {
    expect(COMPANY_SETTING).toBe(COMPANY_KEY);
    expect(dupKey('t1')).toBe(`${DUP_KEY_PREFIX}t1`);
    expect(DUP_KEY_PREFIX).toBe('possible_duplicate:');
  });

  it('flags a pending item that looks already booked', async () => {
    const s = await setup([txn('a'), txn('b', { amountMinor: 7700 })], [entry()]);
    await runDupCheck(s.deps);
    expect(await flag(s.repo, 'a')).toEqual({ doctype: 'Payment Entry', name: 'PE-1', strength: 'strong' });
    expect(await s.repo.getSetting(dupKey('b'))).toBeNull();
  });

  it('the date range is the span of pending items plus 3 days each side, for the company', async () => {
    const s = await setup([txn('a', { occurredOn: '2026-03-01' }), txn('b', { occurredOn: '2026-02-27' }), txn('c', { occurredOn: '2026-03-30' })]);
    await runDupCheck(s.deps);
    expect(s.listBookedEntries).toHaveBeenCalledWith('ZP', '2026-02-24', '2026-04-02');
  });

  it('one list request set per cycle, whatever the number of pending items', async () => {
    const txns = Array.from({ length: 40 }, (_, i) => txn(`t${i}`));
    const s = await setup(txns, [entry()]);
    await runDupCheck(s.deps);
    expect(s.listBookedEntries).toHaveBeenCalledTimes(1);
    expect((await s.repo.listSettings(DUP_KEY_PREFIX))).toHaveLength(40);
  });

  it('a failure leaves old flags untouched and does not reject', async () => {
    const s = await setup([txn('a')], new ErpNetworkError('offline'));
    await s.repo.setSetting(dupKey('a'), JSON.stringify({ doctype: 'Payment Entry', name: 'PE-OLD', strength: 'weak' }));
    await expect(runDupCheck(s.deps)).resolves.toBeUndefined();
    expect(await flag(s.repo, 'a')).toEqual({ doctype: 'Payment Entry', name: 'PE-OLD', strength: 'weak' });
  });

  it('a flag is removed when the entry is no longer returned (cancelled in ERPNext)', async () => {
    const s = await setup([txn('a')], []);
    await s.repo.setSetting(dupKey('a'), JSON.stringify({ doctype: 'Payment Entry', name: 'PE-1', strength: 'strong' }));
    await runDupCheck(s.deps);
    expect(await s.repo.getSetting(dupKey('a'))).toBeNull();
  });

  it('a flag is removed when the item is answered, queued or gone, without asking ERPNext for them', async () => {
    const s = await setup([txn('done', { state: 'created' }), txn('queued')], [entry()]);
    await s.repo.enqueue({
      id: 'op1', txnId: 'queued', plan: { steps: [], summary: [], needsInrAmount: false },
      progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending',
    });
    for (const id of ['done', 'queued', 'gone']) await s.repo.setSetting(dupKey(id), JSON.stringify({ doctype: 'Payment Entry', name: 'PE-1', strength: 'strong' }));
    await runDupCheck(s.deps);
    expect(await s.repo.listSettings(DUP_KEY_PREFIX)).toEqual([]);
    expect(s.listBookedEntries).not.toHaveBeenCalled();
  });

  it('entries from another company are never asked for', async () => {
    const s = await setup([txn('a')], [entry()], 'ZP');
    await runDupCheck(s.deps);
    expect(s.listBookedEntries.mock.calls[0][0]).toBe('ZP');
  });

  it('without a company nothing is asked and nothing changes', async () => {
    const s = await setup([txn('a')], [entry()], null);
    await runDupCheck(s.deps);
    expect(s.listBookedEntries).not.toHaveBeenCalled();
    expect(await s.repo.getSetting(dupKey('a'))).toBeNull();
  });

  it('a stored flag is updated when the match changes', async () => {
    const s = await setup([txn('a')], [entry({ name: 'PE-2', party: null, postingDate: '2026-11-06' })]);
    await s.repo.setSetting(dupKey('a'), JSON.stringify({ doctype: 'Payment Entry', name: 'PE-1', strength: 'strong' }));
    await runDupCheck(s.deps);
    expect(await flag(s.repo, 'a')).toEqual({ doctype: 'Payment Entry', name: 'PE-2', strength: 'weak' });
  });
});

describe('parseDupFlag', () => {
  it('reads a stored flag and rejects anything else', () => {
    expect(parseDupFlag(JSON.stringify({ doctype: 'Journal Entry', name: 'JE-1', strength: 'weak' }))).toEqual({ doctype: 'Journal Entry', name: 'JE-1', strength: 'weak' });
    expect(parseDupFlag(null)).toBeNull();
    expect(parseDupFlag('not json')).toBeNull();
    expect(parseDupFlag(JSON.stringify({ doctype: 'X', name: 'Y', strength: 'maybe' }))).toBeNull();
    expect(parseDupFlag(JSON.stringify({ doctype: '', name: 'Y', strength: 'weak' }))).toBeNull();
  });
});

describe('dupCheckWith', () => {
  it('reads booked entries through the client and flags the item', async () => {
    const repo: Repo = await createRepo(createTestDriver());
    await repo.upsertPending(txn('a'));
    await repo.setSetting(COMPANY_SETTING, 'ZP');
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      const data = url.includes('/Payment%20Entry?')
        ? [{ name: 'PE-9', posting_date: '2026-11-08', payment_type: 'Pay', paid_amount: 500, party_name: 'HP Fuel', docstatus: 1, company: 'ZP' }]
        : [];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }) as unknown as typeof fetch;
    await dupCheckWith(repo, new ErpClient({ siteUrl: 'https://x.example', apiKey: 'k', apiSecret: 's', fetchImpl }))();
    expect(urls).toHaveLength(3);
    expect(await flag(repo, 'a')).toEqual({ doctype: 'Payment Entry', name: 'PE-9', strength: 'strong' });
  });
});
