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
  it('enqueue supersedes the other pending items of the same txn', async () => {
    const r = await mk();
    await r.enqueue(op({ id: 'a' }));
    await r.enqueue(op({ id: 'x', txnId: 't2' }));
    await r.enqueue(op({ id: 'b' }));
    expect((await r.getOutbox('a'))?.status).toBe('superseded');
    expect((await r.getOutbox('x'))?.status).toBe('pending');
    expect((await r.nextOutbox())?.id).toBe('x');
    await r.markOutbox('x', { status: 'done' });
    expect((await r.nextOutbox())?.id).toBe('b');
  });
  it('enqueue is atomic: a failure in the supersede statement rolls the insert back', async () => {
    const base = createTestDriver();
    let failOn: RegExp | null = null;
    const d: SqlDriver = {
      exec: async (sql, params) => { if (failOn && failOn.test(sql)) throw new Error('disk I/O error'); return base.exec(sql, params); },
      all: (sql, params) => base.all(sql, params),
    };
    const r = await createRepo(d);
    await r.enqueue(op({ id: 'a' }));
    failOn = /status = 'superseded'/;
    await expect(r.enqueue(op({ id: 'b' }))).rejects.toThrow('disk I/O error');
    failOn = null;
    expect(await r.getOutbox('b')).toBeNull();
    expect((await r.getOutbox('a'))?.status).toBe('pending');
    // and the connection is usable afterwards (the transaction was closed)
    await r.enqueue(op({ id: 'c' }));
    expect((await r.getOutbox('a'))?.status).toBe('superseded');
  });
  // A driver that yields between statements, like expo-sqlite's async API, so overlapping calls interleave.
  function yieldingDriver(failOn?: { re: RegExp; armed: boolean }) {
    const base = createTestDriver();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const d: SqlDriver = {
      exec: async (sql, params) => { await tick(); if (failOn?.armed && failOn.re.test(sql)) { failOn.armed = false; throw new Error('disk I/O error'); } return base.exec(sql, params); },
      all: async (sql, params) => { await tick(); return base.all(sql, params); },
    };
    return d;
  }

  it('overlapping transactions and plain writes are serialised (no nested BEGIN, no cross-rollback)', async () => {
    const r = await createRepo(yieldingDriver());
    await r.enqueue(op({ id: 'o0' }));
    await Promise.all([
      r.enqueue(op({ id: 'a1' })),
      r.enqueue(op({ id: 'b1', txnId: 't2' })),
      r.upsertPending(txn({ id: 'x', rawHash: 'hx' })),
      r.markOutbox('o0', { attempts: 7 }),
      r.reopenOutbox('o0'),
    ]);
    expect((await r.listOutbox('t1')).map((o) => [o.id, o.status, o.attempts])).toEqual([['o0', 'pending', 7], ['a1', 'superseded', 0]]);
    expect((await r.getOutbox('b1'))?.status).toBe('pending');
    expect(await r.getPending('x')).toEqual(txn({ id: 'x', rawHash: 'hx' }));
  });

  it('a failing transaction rolls back only its own statements; a concurrent upsert survives', async () => {
    const failOn = { re: /status = 'superseded'/, armed: false };
    const r = await createRepo(yieldingDriver(failOn));
    await r.enqueue(op({ id: 'a' }));
    failOn.armed = true;
    const [enq, ups] = await Promise.allSettled([r.enqueue(op({ id: 'b' })), r.upsertPending(txn({ id: 'y', rawHash: 'hy' }))]);
    expect(enq.status).toBe('rejected');
    expect(ups.status).toBe('fulfilled');
    expect(await r.getOutbox('b')).toBeNull();
    expect((await r.getOutbox('a'))?.status).toBe('pending');
    expect(await r.getPending('y')).toEqual(txn({ id: 'y', rawHash: 'hy' }));
  });

  it('a driver error inside a transaction releases the mutex', async () => {
    const failOn = { re: /^INSERT INTO outbox/, armed: true };
    const r = await createRepo(yieldingDriver(failOn));
    await expect(r.enqueue(op({ id: 'a' }))).rejects.toThrow('disk I/O error');
    await r.enqueue(op({ id: 'a' }));
    expect((await r.getOutbox('a'))?.status).toBe('pending');
    await r.setSetting('k', 'v');
    expect(await r.getSetting('k')).toBe('v');
  });

  it('finishOutbox marks done but never overwrites superseded', async () => {
    const r = await mk();
    await r.enqueue(op({ id: 'a' }));
    await r.enqueue(op({ id: 'b' }));
    const p = { stepIndex: 1, created: [{ doctype: 'Payment Entry', name: 'PE-1' }] };
    await r.finishOutbox('a', p);
    await r.finishOutbox('b', p);
    expect(await r.getOutbox('a')).toEqual(op({ id: 'a', status: 'superseded', progress: p }));
    expect(await r.getOutbox('b')).toEqual(op({ id: 'b', status: 'done', progress: p }));
  });
  it('reopenOutbox re-pends an item and supersedes the other pending items of its txn atomically', async () => {
    const r = await mk();
    await r.enqueue(op({ id: 'a' }));
    await r.markOutbox('a', { status: 'failed' });
    await r.enqueue(op({ id: 'b' }));
    await r.reopenOutbox('a');
    expect((await r.getOutbox('a'))?.status).toBe('pending');
    expect((await r.getOutbox('b'))?.status).toBe('superseded');
    expect((await r.listOutbox('t1')).map((o) => o.id)).toEqual(['a', 'b']);
    expect(await r.listOutbox('nope')).toEqual([]);
  });
  it('listOpenOutbox returns the pending and failed items of every txn, oldest first, in one query', async () => {
    const r = await mk();
    await r.enqueue(op({ id: 'a' }));
    await r.markOutbox('a', { status: 'failed' });
    await r.enqueue(op({ id: 'x', txnId: 't2' }));
    await r.enqueue(op({ id: 'y', txnId: 't3' }));
    await r.finishOutbox('y', { stepIndex: 0, created: [] });
    await r.enqueue(op({ id: 'b' })); // supersedes nothing open except t1's pending items ('a' is failed)
    await r.enqueue(op({ id: 'c' })); // supersedes 'b'
    expect((await r.listOpenOutbox()).map((o) => [o.id, o.status])).toEqual([['a', 'failed'], ['x', 'pending'], ['c', 'pending']]);
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

describe('mergeInto (Task 15: correlation writes)', () => {
  it('applies the patch, increments mergedCount and records the source SMS, in one step', async () => {
    const r = await mk();
    const t = txn({ state: 'created', error: 'kept', utr: null, counterparty: null });
    await r.upsertPending(t);
    const res = await r.mergeInto('t1', { utr: 'NEW', counterparty: 'PERSON', state: 'new', id: 'zz', rawHash: 'other', mergedCount: 9, createdDocs: [], error: null } as never, 'src1');
    const want = { ...t, utr: 'NEW', counterparty: 'PERSON', mergedCount: 2 };
    expect(res).toEqual({ status: 'merged', txn: want });
    expect(await r.getPending('t1')).toEqual(want);
    expect(await r.getSetting('merged_sms:src1')).toBe('t1');
    expect(await r.isMergedSms('src1')).toBe(true);
    expect(await r.isMergedSms('src2')).toBe(false);
  });
  it('a handled target (state other than new) only takes utr and counterparty from the patch', async () => {
    for (const state of ['created', 'submitted', 'ignored', 'failed'] as const) {
      const r = await mk();
      const t = txn({ state, kind: 'neft_confirm', utr: null, counterparty: null, accountLast4: null, occurredTime: null, balanceMinor: null });
      await r.upsertPending(t);
      const res = await r.mergeInto('t1', {
        kind: 'ca_debit', occurredOn: '2026-02-02', occurredTime: '11:11', accountLast4: '6507', balanceMinor: 5,
        utr: 'U9', counterparty: 'P9',
      }, 'src1');
      const want = { ...t, utr: 'U9', counterparty: 'P9', mergedCount: 2 };
      expect(res).toEqual({ status: 'merged', txn: want });
      expect(await r.getPending('t1')).toEqual(want);
      expect(await r.isMergedSms('src1')).toBe(true);
    }
  });
  it('a second merge of the same source SMS changes nothing', async () => {
    const r = await mk();
    await r.upsertPending(txn());
    await r.mergeInto('t1', {}, 'src1');
    expect(await r.mergeInto('t1', { utr: 'X' }, 'src1')).toEqual({ status: 'already' });
    expect((await r.getPending('t1'))!.mergedCount).toBe(2);
    expect((await r.getPending('t1'))!.utr).toBe('UTR1');
  });
  it('a missing target changes nothing', async () => {
    const r = await mk();
    expect(await r.mergeInto('nope', {}, 'src1')).toEqual({ status: 'missing' });
    expect(await r.isMergedSms('src1')).toBe(false);
  });
  it('rolls back the pending write when the marker write fails', async () => {
    const real = createTestDriver();
    let armed = false;
    const d: SqlDriver = {
      all: (s, p) => real.all(s, p),
      exec: async (s, p) => {
        if (armed && s.includes('INSERT INTO settings')) throw new Error('boom');
        return real.exec(s, p);
      },
    };
    const r = await createRepo(d);
    await r.upsertPending(txn());
    armed = true;
    await expect(r.mergeInto('t1', { utr: 'X' }, 'src1')).rejects.toThrow('boom');
    expect((await r.getPending('t1'))!).toEqual(txn());
  });
});

describe('resetForNewSite (Task 16)', () => {
  const MAP: AccountMapping = { bankAccount: 'B', glAccount: 'G', kind: 'bank', senderIds: ['IDFCFB'], last4: ['1234'], modeOfPayment: 'Wire Transfer' };
  const RULE: Rule = { matchKey: 'k', action: 'expense', account: 'Rent', hits: 1, lastUsed: 1 };

  it('removes mappings, rules, pending, outbox, merged markers and settings, but keeps the template cache', async () => {
    const r = await mk();
    await r.saveMapping(MAP);
    await r.saveRule(RULE);
    await r.upsertPending(txn());
    await r.enqueue(op());
    await r.mergeInto('t1', { merchant: 'M' }, 'srcHash');
    await r.setSetting('company', 'A Co');
    await r.setSetting('site_url', 'https://a.example');
    await r.setSetting('templates_json', '{}');
    await r.setSetting('templates_version', '3');
    await r.resetForNewSite();
    expect(await r.listMappings()).toEqual([]);
    expect(await r.listRules()).toEqual([]);
    expect(await r.listPending()).toEqual([]);
    expect(await r.nextOutbox()).toBeNull();
    expect(await r.isMergedSms('srcHash')).toBe(false);
    expect(await r.getSetting('company')).toBeNull();
    expect(await r.getSetting('site_url')).toBeNull();
    expect(await r.getSetting('templates_json')).toBe('{}');
    expect(await r.getSetting('templates_version')).toBe('3');
  });

  it('is atomic and serialised with concurrent repo calls', async () => {
    const r = await mk();
    await r.saveMapping(MAP);
    await r.upsertPending(txn());
    const results = await Promise.allSettled([
      r.resetForNewSite(),
      r.upsertPending(txn({ id: 'late', rawHash: 'hl' })),
      r.setSetting('after', '1'),
    ]);
    expect(results.every((x) => x.status === 'fulfilled')).toBe(true);
    // calls queued after the reset survive it; everything before is gone
    expect((await r.listPending()).map((p) => p.id)).toEqual(['late']);
    expect(await r.listMappings()).toEqual([]);
    expect(await r.getSetting('after')).toBe('1');
  });
});
