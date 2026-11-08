import { createTestDriver } from './testDriver';
import { createRepo } from './repo';
import { migrate, SCHEMA_VERSION } from './schema';
import type { SqlDriver } from './schema';
import type { PendingTxn, AccountMapping, Rule, OutboxOp } from '../core/types';

const txn = (over: Partial<PendingTxn> = {}): PendingTxn => ({
  id: 't1', mergedCount: 1, state: 'new',
  createdDocs: [{ doctype: 'Payment Entry', name: 'PE-0001', docstatus: 0 }], error: null,
  kind: 'ca_credit', direction: 'in', amountMinor: 123456, currency: 'INR',
  occurredOn: '2026-01-02', occurredTime: '10:30', accountType: 'bank', accountLast4: '3455',
  counterparty: 'ACME', utr: 'UTR1', merchant: null, balanceMinor: 99999999,
  sender: 'AX-IDFCFB', receivedAt: 1700000000000, rawHash: 'h1', ...over,
});

const op = (over: Partial<OutboxOp> = {}): OutboxOp => ({
  id: 'o1', txnId: 't1',
  plan: { steps: [{ kind: 'create_doc', doctype: 'Payment Entry', body: { a: 1 } }], summary: ['s'], needsInrAmount: false },
  progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending', ...over,
});

async function mk() { return createRepo(createTestDriver()); }

describe('pending txns', () => {
  it('round-trips all fields incl. createdDocs and mergedCount', async () => {
    const r = await mk();
    const t = txn({ mergedCount: 2, accountLast4: null, occurredTime: null, utr: null, error: 'x' });
    await r.upsertPending(t);
    expect(await r.getPending('t1')).toEqual(t);
    expect(await r.getPending('nope')).toBeNull();
  });
  it('lists, optionally filtered by state', async () => {
    const r = await mk();
    await r.upsertPending(txn());
    await r.upsertPending(txn({ id: 't2', rawHash: 'h2', state: 'submitted' }));
    expect((await r.listPending()).length).toBe(2);
    expect((await r.listPending('submitted')).map((x) => x.id)).toEqual(['t2']);
  });
  it('upsert with same id updates in place', async () => {
    const r = await mk();
    await r.upsertPending(txn());
    await r.upsertPending(txn({ state: 'created' }));
    const all = await r.listPending();
    expect(all).toHaveLength(1);
    expect(all[0].state).toBe('created');
  });
  it('re-delivery under a new id leaves the existing row untouched', async () => {
    const r = await mk();
    const orig = txn({ state: 'created', mergedCount: 2 });
    await r.upsertPending(orig);
    await r.upsertPending(txn({ id: 'other', state: 'new', mergedCount: 1, createdDocs: [] }));
    expect(await r.listPending()).toEqual([orig]);
    expect(await r.getPending('other')).toBeNull();
  });
  it('same id with changed fields updates the row', async () => {
    const r = await mk();
    await r.upsertPending(txn());
    const next = txn({ state: 'submitted', mergedCount: 3, createdDocs: [], error: 'e' });
    await r.upsertPending(next);
    expect(await r.listPending()).toEqual([next]);
  });
  it('concurrent upserts of the same new rawHash leave one row, none reject', async () => {
    const r = await mk();
    await Promise.all([r.upsertPending(txn({ id: 'a' })), r.upsertPending(txn({ id: 'b' }))]);
    expect(await r.listPending()).toHaveLength(1);
  });
});

describe('corrupt JSON', () => {
  it('lists survive corrupt created_docs / last4 / sender_ids / rule party', async () => {
    const d = createTestDriver();
    const r = await createRepo(d);
    await r.upsertPending(txn()); await r.upsertPending(txn({ id: 't2', rawHash: 'h2' }));
    await d.exec(`UPDATE pending_txn SET created_docs = 'oops' WHERE id = 't1'`);
    const ps = await r.listPending();
    expect(ps).toHaveLength(2);
    expect(ps.find((p) => p.id === 't1')!.createdDocs).toEqual([]);
    await r.saveMapping({ bankAccount: 'A', glAccount: 'G', kind: 'bank', senderIds: ['X'], last4: ['1'], modeOfPayment: 'm' });
    await r.saveMapping({ bankAccount: 'B', glAccount: 'G', kind: 'bank', senderIds: ['X'], last4: ['2'], modeOfPayment: 'm' });
    await d.exec(`UPDATE account_mapping SET last4 = '{x', sender_ids = '{y' WHERE bank_account = 'A'`);
    const ms = await r.listMappings();
    expect(ms).toHaveLength(2);
    expect(ms[0]).toMatchObject({ bankAccount: 'A', last4: [], senderIds: [] });
    await r.saveRule({ matchKey: 'k1', action: 'personal', party: { doctype: 'Supplier', name: 'S' }, hits: 0, lastUsed: 0 });
    await r.saveRule({ matchKey: 'k2', action: 'personal', hits: 0, lastUsed: 0 });
    await d.exec(`UPDATE rule SET party = 'bad' WHERE match_key = 'k1'`);
    const rs = await r.listRules();
    expect(rs).toHaveLength(2);
    expect(rs[0].party).toBeUndefined();
  });
  it('nextOutbox skips and fails a corrupt head row', async () => {
    for (const col of ['plan', 'progress']) {
      const d = createTestDriver();
      const r = await createRepo(d);
      await r.enqueue(op({ id: 'o1' })); await r.enqueue(op({ id: 'o2', txnId: 't2' }));
      await d.exec(`UPDATE outbox SET ${col} = 'garbage' WHERE id = 'o1'`);
      expect((await r.nextOutbox())?.id).toBe('o2');
      expect(await d.all(`SELECT status, attempts FROM outbox WHERE id = 'o1'`)).toEqual([{ status: 'failed', attempts: 0 }]);
    }
  });
});

describe('mappings, rules, outbox, settings', () => {
  it('mapping with several last4 round-trips', async () => {
    const r = await mk();
    const m: AccountMapping = { bankAccount: 'IDFC - A', glAccount: 'Bank - X', kind: 'bank', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Bank Draft' };
    await r.saveMapping(m);
    const got = await r.listMappings();
    expect(got).toEqual([m]);
    expect(got.some((x) => x.last4.includes('3455'))).toBe(true);
    expect(got.some((x) => x.last4.includes('8129'))).toBe(true);
    await r.saveMapping({ ...m, last4: ['1111'] });
    expect((await r.listMappings())[0].last4).toEqual(['1111']);
  });
  it('rules round-trip with and without optional fields; save replaces by matchKey', async () => {
    const r = await mk();
    const a: Rule = { matchKey: 'k1', action: 'supplier_payment', party: { doctype: 'Supplier', name: 'S' }, account: 'Acc', hits: 1, lastUsed: 5 };
    const b: Rule = { matchKey: 'k2', action: 'personal', hits: 0, lastUsed: 6 };
    await r.saveRule(a); await r.saveRule(b);
    await r.saveRule({ ...a, hits: 2 });
    const got = await r.listRules();
    expect(got).toHaveLength(2);
    expect(got.find((x) => x.matchKey === 'k1')).toEqual({ ...a, hits: 2 });
    expect(got.find((x) => x.matchKey === 'k2')).toEqual(b);
  });
  it('outbox: oldest pending first, markOutbox patches', async () => {
    const r = await mk();
    expect(await r.nextOutbox()).toBeNull();
    await r.enqueue(op({ id: 'o1' }));
    await r.enqueue(op({ id: 'o2', txnId: 't2' }));
    expect(await r.nextOutbox()).toEqual(op({ id: 'o1' }));
    await r.markOutbox('o1', { status: 'done', attempts: 1, progress: { stepIndex: 1, created: [{ doctype: 'Payment Entry', name: 'PE-1' }] } });
    expect((await r.nextOutbox())?.id).toBe('o2');
    await r.markOutbox('o2', { attempts: 3 });
    expect((await r.nextOutbox())?.attempts).toBe(3);
    await r.markOutbox('o2', { status: 'failed' });
    expect(await r.nextOutbox()).toBeNull();
  });
  it('getOutbox reads any item by id, whatever its status', async () => {
    const r = await mk();
    expect(await r.getOutbox('o1')).toBeNull();
    await r.enqueue(op({ id: 'o1' }));
    await r.markOutbox('o1', { status: 'failed', attempts: 2, progress: { stepIndex: 1, created: [{ doctype: 'Customer', name: 'C' }] } });
    expect(await r.getOutbox('o1')).toEqual(op({ id: 'o1', status: 'failed', attempts: 2, progress: { stepIndex: 1, created: [{ doctype: 'Customer', name: 'C' }] } }));
  });
  it('supersedePending marks only other pending items of the txn, and nextOutbox skips them', async () => {
    const r = await mk();
    await r.enqueue(op({ id: 'a' }));
    await r.enqueue(op({ id: 'f', status: 'failed' }));
    await r.enqueue(op({ id: 'b' }));
    await r.enqueue(op({ id: 'x', txnId: 't2' }));
    await r.supersedePending('t1', 'b');
    expect((await r.getOutbox('a'))?.status).toBe('superseded');
    expect((await r.getOutbox('f'))?.status).toBe('failed');
    expect((await r.getOutbox('b'))?.status).toBe('pending');
    expect((await r.getOutbox('x'))?.status).toBe('pending');
    expect((await r.nextOutbox())?.id).toBe('b');
  });
  it('settings get/set', async () => {
    const r = await mk();
    expect(await r.getSetting('a')).toBeNull();
    await r.setSetting('a', '1'); await r.setSetting('a', '2');
    expect(await r.getSetting('a')).toBe('2');
  });
});

describe('migrations', () => {
  it('v1 -> v2 keeps rows and adds the state index', async () => {
    const d = createTestDriver();
    await migrate(d, 1);
    const v = await d.all<{ version: number }>('SELECT version FROM schema_version');
    expect(v).toEqual([{ version: 1 }]);
    expect(await d.all("SELECT name FROM sqlite_master WHERE name='idx_pending_state'")).toHaveLength(0);
    await d.exec(
      `INSERT INTO pending_txn (id, raw_hash, state, merged_count, created_docs, kind, direction,
         amount_minor, currency, occurred_on, account_type, sender, received_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ['t1', 'h1', 'new', 1, '[]', 'ca_credit', 'in', 100, 'INR', '2026-01-02', 'bank', 'S', 1],
    );
    await d.exec(`INSERT INTO settings (key, value) VALUES (?,?)`, ['k', 'v']);
    await migrate(d);
    expect(await d.all<{ version: number }>('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }]);
    expect(SCHEMA_VERSION).toBe(2);
    expect(await d.all("SELECT name FROM sqlite_master WHERE name='idx_pending_state'")).toHaveLength(1);
    expect(await d.all('SELECT id FROM pending_txn')).toEqual([{ id: 't1' }]);
    expect(await d.all('SELECT value FROM settings')).toEqual([{ value: 'v' }]);
  });
  it('migrate is idempotent', async () => {
    const d = createTestDriver();
    await migrate(d); await migrate(d);
    expect(await d.all('SELECT version FROM schema_version')).toHaveLength(1);
  });
  it('a failure partway through a step rolls back; a rerun succeeds', async () => {
    const real = createTestDriver();
    let armed = true;
    const flaky: SqlDriver = {
      all: (s, p) => real.all(s, p),
      exec: async (s, p) => {
        if (armed && s.includes('CREATE TABLE IF NOT EXISTS rule')) throw new Error('boom');
        return real.exec(s, p);
      },
    };
    await expect(migrate(flaky)).rejects.toThrow('boom');
    expect(await real.all('SELECT version FROM schema_version')).toEqual([{ version: 0 }]);
    expect(await real.all("SELECT name FROM sqlite_master WHERE type='table' AND name='pending_txn'")).toHaveLength(0);
    armed = false;
    await migrate(flaky);
    expect(await real.all('SELECT version FROM schema_version')).toEqual([{ version: SCHEMA_VERSION }]);
    expect(await real.all("SELECT name FROM sqlite_master WHERE name IN ('pending_txn','rule','idx_pending_state')")).toHaveLength(3);
  });
});
