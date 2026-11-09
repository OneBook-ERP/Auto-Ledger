import { ErpNetworkError } from '../erp/client';
import { outboxIdFor } from '../outbox/runner';
import fixtures from '../../fixtures/sms/idfc.json';
import idfc from '../../templates/idfc.json';
import { createRepo, type Repo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import type { SqlDriver } from '../data/schema';
import { parseSms } from '../core/parser';
import type { AccountMapping, ParsedTxn, PendingTxn, TemplateSet } from '../core/types';
import type { PermissionState, QueuedSms, RawSms } from '../../modules/sms-ingest/src';
import type { DrainErp } from './drain';
import {
  BACKFILL_CHOICES, BACKFILL_DAYS_KEY, DEFAULT_BACKFILL_DAYS, ensureBackfill, ingest, resolveMapping, runForegroundCycle,
  syncSenderPatterns, type NativeBridge,
} from './pipeline';

type Fixture = { id: string; sender: string; body: string; receivedAt: number; expected: any };
const fx = (id: string): Fixture => {
  const f = (fixtures as Fixture[]).find((x) => x.id === id);
  if (!f) throw new Error(id);
  return f;
};
type Sms = { sender: string; body: string; receivedAt: number };
const templates = idfc as TemplateSet;

const NOW = 1794200000000; // 2026-11-08
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const BANK: AccountMapping = {
  bankAccount: 'IDFC CA', glAccount: 'IDFC CA - AL', kind: 'bank', senderIds: ['IDFCFB'], last4: ['6507'], modeOfPayment: 'Bank Transfer',
};
const CARD: AccountMapping = {
  bankAccount: 'IndiGo Card', glAccount: 'IndiGo Card - AL', kind: 'card', senderIds: ['IDFCFB'], last4: ['3455', '8129'], modeOfPayment: 'Credit Card',
};

// ---------- fake native bridge ----------

class FakeNative implements NativeBridge {
  queue: QueuedSms[] = [];
  inbox: RawSms[] = [];
  acked: string[][] = [];
  patterns: string[] | null = null;
  perm: PermissionState = { receive: true, read: true, notifications: true };
  backfillCalls: [number, string[]][] = [];
  failAck = 0;
  log: string[] = [];
  private seq = 0;

  push(s: Sms, kind = 'ca_credit'): string {
    const id = `q${++this.seq}`;
    this.queue.push({ id, sender: s.sender, body: s.body, receivedAt: s.receivedAt, kind });
    return id;
  }
  async peek() { this.log.push('peek'); return this.queue.map((q) => ({ ...q })); }
  async ack(ids: string[]) {
    this.log.push('ack');
    if (this.failAck > 0) { this.failAck--; throw new Error('process killed before ack'); }
    this.acked.push([...ids]);
    this.queue = this.queue.filter((q) => !ids.includes(q.id));
  }
  async backfill(days: number, senderPatterns: string[]) {
    this.log.push('backfill');
    this.backfillCalls.push([days, senderPatterns]);
    return this.inbox.map((r) => ({ ...r }));
  }
  async setSenderPatterns(p: string[]) { this.log.push('setSenderPatterns'); this.patterns = [...p]; }
  async getSenderPatterns() { return this.patterns ?? []; }
  async setTemplates() { return true; }
  async getTemplatesInfo() { return { source: 'bundled' as const, version: 1 }; }
  async engineHealth() { return { usable: true, reason: '' }; }
  async hasPermission() { this.log.push('hasPermission'); return { ...this.perm }; }
  async droppedCount() { return 0; }
}

// ---------- setup ----------

async function setup(mappings: AccountMapping[] = [BANK, CARD]) {
  const driver: SqlDriver = createTestDriver();
  const repo = await createRepo(driver);
  for (const m of mappings) await repo.saveMapping(m);
  const native = new FakeNative();
  return { driver, repo, native, deps: { repo, native, now: () => NOW } };
}

const parsed = (s: Sms): ParsedTxn => {
  const r = parseSms(s.sender, s.body, s.receivedAt, templates);
  if (!r.ok) throw new Error(`fixture did not parse: ${r.reason}`);
  return r.txn;
};
const idOf = (s: Sms) => `t_${parsed(s).rawHash}`;

// Synthetic variants of real formats.
const shortDebit = (amount: string, receivedAt: number, time = '12:30', bal = '41,835.72'): Sms => ({
  sender: 'AX-IDFCFB-S',
  body: `Your A/C XXXXX996507 is debited by INR ${amount} on 19/10/26 ${time}. New Bal :INR ${bal}. Call us on 1800 10 888 for dispute. Team IDFC FIRST Bank`,
  receivedAt,
});
const neftConfirm = (name: string, amount: string, utr: string, receivedAt: number): Sms => ({
  sender: 'JD-IDFCFB-S',
  body: `Your beneficiary ${name} has received Rs. ${amount} transferred via NEFT UTR ${utr}.\nTeam IDFC First Bank.`,
  receivedAt,
});
const at = (s: Sms, receivedAt: number): Sms => ({ ...s, receivedAt });

const empty = { inserted: 0, enriched: 0, duplicates: 0, ignored: 0, unrecognised: 0, unmappedAccounts: [], errors: 0 };

// ---------- resolveMapping ----------

describe('resolveMapping', () => {
  const t = (over: Partial<ParsedTxn>): ParsedTxn => ({ ...parsed(fx('idfc-001')), ...over });

  it('maps both cards of the dual card (3455, 8129) to the one card mapping', () => {
    expect(resolveMapping([BANK, CARD], parsed(fx('idfc-033')))).toBe(CARD);
    expect(resolveMapping([BANK, CARD], parsed(fx('idfc-025')))).toBe(CARD);
    expect(parsed(fx('idfc-025')).accountLast4).toBe('8129');
  });
  it('maps the current account by last-4 and kind', () => {
    expect(resolveMapping([BANK, CARD], parsed(fx('idfc-001')))).toBe(BANK);
    expect(resolveMapping([CARD], parsed(fx('idfc-001')))).toBeNull();
    expect(resolveMapping([BANK, CARD], t({ accountType: 'card', accountLast4: '6507' }))).toBeNull();
    expect(resolveMapping([BANK, CARD], t({ accountLast4: '1111' }))).toBeNull();
  });
  it('requires the sender to match one of the mapping senderIds', () => {
    expect(resolveMapping([BANK], t({ sender: 'AX-HDFCBK-S' }))).toBeNull();
    expect(resolveMapping([BANK], t({ sender: 'ax-idfcfb-s' }))).toBe(BANK);
  });
  it('null last-4 (IMPS/SI): the only mapping of that kind, else null', () => {
    const imps = parsed(fx('idfc-016'));
    expect(imps.accountLast4).toBeNull();
    expect(resolveMapping([BANK, CARD], imps)).toBe(BANK);
    const BANK2: AccountMapping = { ...BANK, bankAccount: 'IDFC CA 2', last4: ['9999'] };
    expect(resolveMapping([BANK, BANK2, CARD], imps)).toBeNull();
    expect(resolveMapping([CARD], imps)).toBeNull();
    expect(resolveMapping([], imps)).toBeNull();
  });
});

// ---------- syncSenderPatterns ----------

describe('syncSenderPatterns', () => {
  it('passes the union of all mapping senderIds to native', async () => {
    const HDFC: AccountMapping = { ...BANK, bankAccount: 'HDFC CA', senderIds: ['HDFCBK', 'IDFCFB'], last4: ['1234'] };
    const { deps, native } = await setup([BANK, CARD, HDFC]);
    expect(await syncSenderPatterns(deps)).toEqual(['HDFCBK', 'IDFCFB']);
    expect(native.patterns).toEqual(['HDFCBK', 'IDFCFB']);
  });
  it('sets [] when there are no mappings (fail closed)', async () => {
    const { deps, native } = await setup([]);
    native.patterns = ['STALE'];
    expect(await syncSenderPatterns(deps)).toEqual([]);
    expect(native.patterns).toEqual([]);
  });
});

// ---------- ingest: peek / ack ----------

describe('ingest: peek and ack', () => {
  it('draining the same 3 messages twice yields 3 inserts then 0', async () => {
    const { deps, native, repo } = await setup();
    const three = [fx('idfc-001'), fx('idfc-033'), fx('idfc-025')];
    const ids = three.map((s) => native.push(s));
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 3 });
    expect(native.acked).toEqual([ids]);
    expect(native.queue).toEqual([]);

    const rows = await repo.listPending();
    expect(rows.length).toBe(3);
    const credit = rows.find((r) => r.amountMinor === 1293200)!;
    expect(credit).toEqual({
      ...parsed(fx('idfc-001')), id: idOf(fx('idfc-001')), state: 'new', createdDocs: [], error: null, mergedCount: 1,
    } satisfies PendingTxn);

    three.forEach((s) => native.push(s)); // re-delivered (e.g. the receiver stored them twice)
    expect(await ingest(deps)).toEqual({ ...empty, duplicates: 3 });
    expect(native.queue).toEqual([]);
    expect(await repo.listPending()).toEqual(rows);
  });

  it('a crash between the repo writes and the ack: the next run re-processes and creates nothing new', async () => {
    const { deps, native, repo } = await setup();
    const debit = shortDebit('30,000.00', fx('idfc-018').receivedAt - 20 * 60_000);
    native.push(debit, 'ca_debit');
    native.push(fx('idfc-018'), 'neft_confirm'); // enriches the debit
    native.push(fx('idfc-033'), 'card_spend');
    native.failAck = 1;
    const first = await ingest(deps);
    expect(first).toMatchObject({ inserted: 2, enriched: 1, errors: 3 });
    expect(native.queue.length).toBe(3); // nothing acked
    const after1 = await repo.listPending();
    expect(after1.length).toBe(2);
    expect(after1.find((r) => r.id === idOf(debit))).toMatchObject({ mergedCount: 2, utr: 'IDFB6292M4509651', counterparty: 'PERSON_13' });

    expect(await ingest(deps)).toEqual({ ...empty, duplicates: 3 });
    expect(native.queue).toEqual([]);
    expect(await repo.listPending()).toEqual(after1);
  });

  it('an exception on one item does not block the others and that item is not acked', async () => {
    const { deps, native, repo } = await setup();
    let armed = true;
    const flaky: Repo = {
      ...repo,
      async upsertPending(t) {
        if (armed && t.amountMinor === 1293200) throw new Error('disk I/O error');
        return repo.upsertPending(t);
      },
    };
    const a = native.push(fx('idfc-002'));
    const b = native.push(fx('idfc-001'));
    const c = native.push(fx('idfc-033'), 'card_spend');
    expect(await ingest({ ...deps, repo: flaky })).toEqual({ ...empty, inserted: 2, errors: 1 });
    expect(native.acked).toEqual([[a, c]]);
    expect(native.queue.map((q) => q.id)).toEqual([b]);

    armed = false;
    expect(await ingest({ ...deps, repo: flaky })).toEqual({ ...empty, inserted: 1 });
    expect(native.queue).toEqual([]);
    expect((await repo.listPending()).length).toBe(3);
  });

  it('items that parse as {ok:false} are dropped: acked live (non-money native kind) and via backfill', async () => {
    const ids = ['synthetic-otp', 'idfc-042', 'idfc-051', 'idfc-057', 'idfc-053'];
    const { deps, native, repo } = await setup();
    for (const id of ids) native.push(fx(id), 'ignore');
    expect(await ingest(deps)).toEqual({ ...empty, ignored: 5 });
    expect(native.queue).toEqual([]);
    native.inbox = ids.map(fx);
    expect(await ensureBackfill(deps)).toEqual({ ...empty, ignored: 5 });
    expect(await repo.listPending()).toEqual([]);
    expect(await repo.getSetting('unrecognised_count')).toBeNull();
    expect(await repo.getSetting('engine_disagreement_count')).toBeNull();
  });

  it('engine disagreement: a native money kind TS cannot parse is acked and counted, never silently dropped', async () => {
    const { deps, native, repo, driver } = await setup();
    // Native read it as a debit (e.g. a refreshed set TS does not have); the bundled TS set cannot.
    const body = 'IDFC FIRST Bank: INR 4,200.00 debited from A/c XX1234 on 06/11/26 towards EXAMPLE PAYEE. Team IDFC FIRST Bank';
    native.push({ sender: 'AX-IDFCFB-S', body, receivedAt: NOW - HOUR }, 'ca_debit');
    native.push(fx('synthetic-otp'), 'card_spend'); // even an OTP verdict counts: native kept it as money
    native.push(fx('idfc-001')); // agreement: stored as usual
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1, unrecognised: 2 });
    expect(native.queue).toEqual([]);
    expect(await repo.getSetting('unrecognised_count')).toBe('2');
    expect(await repo.getSetting('engine_disagreement_count')).toBe('2');
    expect((await repo.listPending()).length).toBe(1);
    const dump = JSON.stringify([await driver.all('SELECT * FROM pending_txn'), await driver.all('SELECT * FROM settings')]);
    expect(dump).not.toMatch(/EXAMPLE PAYEE|is your OTP/);
  });

  it('an item from a sender no mapping knows is acked and dropped', async () => {
    const { deps, native, repo } = await setup([{ ...BANK, senderIds: ['HDFCBK'] }, { ...CARD, senderIds: ['HDFCBK'] }]);
    native.push(fx('idfc-001'));
    expect(await ingest(deps)).toEqual({ ...empty, ignored: 1 });
    expect(native.queue).toEqual([]);
    expect(await repo.listPending()).toEqual([]);
  });

  it('native "unrecognised" items are acked and counted in unrecognised_count without a PendingTxn', async () => {
    const { deps, native, repo } = await setup();
    const upi = { sender: 'AX-IDFCFB-S', body: 'Rs 500.00 debited from your IDFC FIRST Bank a/c via UPI to shop@okaxis. Ref 12345678', receivedAt: NOW - HOUR };
    native.push(upi, 'unrecognised');
    native.push({ ...upi, body: upi.body.replace('500.00', '750.00') }, 'unrecognised');
    expect(await ingest(deps)).toEqual({ ...empty, unrecognised: 2 });
    expect(native.queue).toEqual([]);
    expect(await repo.listPending()).toEqual([]);
    expect(await repo.getSetting('unrecognised_count')).toBe('2');
    native.push({ ...upi, body: upi.body.replace('500.00', '900.00') }, 'unrecognised');
    expect(await ingest(deps)).toEqual({ ...empty, unrecognised: 1 });
    expect(await repo.getSetting('unrecognised_count')).toBe('3');
  });

  it('a native "unrecognised" item that the TS parser does read (native engine unusable) is stored, not lost', async () => {
    const { deps, native, repo } = await setup();
    native.push(fx('idfc-001'), 'unrecognised');
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1 });
    expect((await repo.listPending()).length).toBe(1);
    expect(await repo.getSetting('unrecognised_count')).toBeNull();
  });

  it('an unmapped account (sender known, last-4 unknown) is not stored, flagged once and reported', async () => {
    const { deps, native, repo } = await setup();
    const card9999 = { ...fx('idfc-033'), body: fx('idfc-033').body.replace(/3455/g, '9999') };
    const bank1111 = { ...fx('idfc-001'), body: fx('idfc-001').body.replace('996507', '991111') };
    native.push(card9999, 'card_spend');
    native.push(bank1111);
    expect(await ingest(deps)).toEqual({ ...empty, unmappedAccounts: ['1111', '9999'] }); // oldest first
    expect(native.queue).toEqual([]);
    expect(await repo.listPending()).toEqual([]);
    expect(await repo.getSetting('unrecognised_account:9999')).toBe(String(NOW));
    expect(await repo.getSetting('unrecognised_account:1111')).toBe(String(NOW));

    // One-time: a later message from the same account is counted again but does not reset the flag.
    native.push({ ...card9999, body: card9999.body.replace('INR 3.00', 'INR 4.00') }, 'card_spend');
    expect(await ingest({ ...deps, now: () => NOW + DAY })).toEqual({ ...empty, unmappedAccounts: ['9999'] });
    expect(await repo.getSetting('unrecognised_account:9999')).toBe(String(NOW));
  });

  it('a card last-4 is unmapped when only a bank mapping lists it', async () => {
    const { deps, native, repo } = await setup([{ ...BANK, last4: ['6507', '3455'] }]);
    native.push(fx('idfc-033'), 'card_spend');
    expect(await ingest(deps)).toEqual({ ...empty, unmappedAccounts: ['3455'] });
    expect(await repo.listPending()).toEqual([]);
  });

  it('null last-4 (IMPS) is stored whether one or several mappings of that kind exist', async () => {
    const BANK2: AccountMapping = { ...BANK, bankAccount: 'IDFC CA 2', last4: ['9999'] };
    for (const maps of [[BANK, CARD], [BANK, BANK2, CARD]]) {
      const { deps, native, repo } = await setup(maps);
      native.push(fx('idfc-016'), 'ca_debit');
      expect(await ingest(deps)).toEqual({ ...empty, inserted: 1 });
      expect((await repo.listPending())[0].accountLast4).toBeNull();
    }
  });

  it('never stores or logs raw bodies', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((k) => jest.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const { deps, native, driver } = await setup();
      native.push(fx('idfc-001'));
      native.push(fx('idfc-010'), 'ca_debit');
      native.push(fx('idfc-018'), 'neft_confirm');
      native.push({ ...fx('idfc-033'), body: fx('idfc-033').body.replace(/3455/g, '9999') }, 'card_spend');
      native.push({ sender: 'AX-IDFCFB-S', body: 'Rs 500.00 debited from your IDFC FIRST Bank a/c via UPI. Team IDFC FIRST Bank', receivedAt: NOW }, 'unrecognised');
      await ingest(deps);
      const dump = JSON.stringify([
        await driver.all('SELECT * FROM pending_txn'), await driver.all('SELECT * FROM settings'), await driver.all('SELECT * FROM outbox'),
      ]);
      expect(dump).not.toMatch(/Team IDFC|has received|Avbl Limit|via UPI/i);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------- correlation contract ----------

describe('ingest: correlation', () => {
  it('drop_duplicate empty_patch increments the target mergedCount', async () => {
    const { deps, native, repo } = await setup();
    native.push(fx('idfc-010'), 'ca_debit'); // carries UTR and name
    native.push(fx('idfc-018'), 'neft_confirm'); // nothing to add
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1, duplicates: 1 });
    const rows = await repo.listPending();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: idOf(fx('idfc-010')), mergedCount: 2, kind: 'ca_debit', state: 'new' });
  });

  it('drop_duplicate paired increments the target mergedCount', async () => {
    const { deps, native, repo } = await setup();
    const siPaid = fx('idfc-041');
    native.push(at(fx('idfc-035'), siPaid.receivedAt - 60_000), 'card_spend'); // spend first: the SI notice only pairs
    native.push(siPaid, 'card_si_paid');
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1, duplicates: 1 });
    const rows = await repo.listPending();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ kind: 'card_spend', mergedCount: 2 });
  });

  it('same_sms changes nothing', async () => {
    const { deps, native, repo } = await setup();
    native.push(fx('idfc-010'), 'ca_debit');
    await ingest(deps);
    const before = await repo.listPending();
    native.push(at(fx('idfc-010'), fx('idfc-010').receivedAt + 5_000), 'ca_debit'); // same text, later delivery
    expect(await ingest(deps)).toEqual({ ...empty, duplicates: 1 });
    expect(await repo.listPending()).toEqual(before);
  });

  it('enrich applies the patch and increments mergedCount but never changes state, createdDocs or error', async () => {
    const { deps, native, repo } = await setup();
    const debit = shortDebit('30,000.00', fx('idfc-018').receivedAt - 20 * 60_000);
    native.push(debit, 'ca_debit');
    await ingest(deps);
    const id = idOf(debit);
    const handled: PendingTxn = {
      ...(await repo.getPending(id))!, state: 'created', error: 'note',
      createdDocs: [{ doctype: 'Journal Entry', name: 'ACC-JV-0001', docstatus: 0 }],
    };
    await repo.upsertPending(handled);
    native.push(fx('idfc-018'), 'neft_confirm');
    expect(await ingest(deps)).toEqual({ ...empty, enriched: 1 });
    expect(await repo.listPending()).toEqual([{ ...handled, utr: 'IDFB6292M4509651', counterparty: 'PERSON_13', mergedCount: 2 }]);
  });

  it('enrich when the confirmation came first: the debit becomes canonical on the confirmation item', async () => {
    const { deps, native, repo } = await setup();
    const conf = fx('idfc-018');
    native.push(conf, 'neft_confirm');
    await ingest(deps);
    native.push(shortDebit('30,000.00', conf.receivedAt + 60_000), 'ca_debit');
    expect(await ingest(deps)).toEqual({ ...empty, enriched: 1 });
    const rows = await repo.listPending();
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ id: idOf(conf), kind: 'ca_debit', accountLast4: '6507', occurredTime: '12:30', mergedCount: 2, utr: 'IDFB6292M4509651' });
  });

  it('a handled target keeps what was posted: confirmation first, created, then the debit only bumps mergedCount', async () => {
    const { deps, native, repo } = await setup();
    const conf = fx('idfc-018');
    native.push(conf, 'neft_confirm');
    await ingest(deps);
    const handled: PendingTxn = {
      ...(await repo.getPending(idOf(conf)))!, state: 'created',
      createdDocs: [{ doctype: 'Payment Entry', name: 'ACC-PAY-0001', docstatus: 0 }],
    };
    await repo.upsertPending(handled);
    const debit = shortDebit('30,000.00', conf.receivedAt + 60_000);
    native.push(debit, 'ca_debit');
    expect(await ingest(deps)).toEqual({ ...empty, enriched: 1 });
    expect(await repo.listPending()).toEqual([{ ...handled, mergedCount: 2 }]); // kind, date, time, last-4, balance unchanged
    native.push(debit, 'ca_debit'); // re-delivery: the marker was written
    expect(await ingest(deps)).toEqual({ ...empty, duplicates: 1 });
    expect(await repo.listPending()).toEqual([{ ...handled, mergedCount: 2 }]);
  });

  it('one pairing per item: debit + NEFT confirmation + a later equal-amount debit + its confirmation', async () => {
    const { deps, native, repo } = await setup();
    const t0 = fx('idfc-018').receivedAt - 20 * 60_000;
    const d1 = shortDebit('30,000.00', t0, '12:30', '41,835.72');
    const c1 = fx('idfc-018'); // t0 + 20 min, UTR IDFB6292M4509651
    const d2 = shortDebit('30,000.00', t0 + HOUR, '13:30', '11,835.72');
    const c2 = neftConfirm('PERSON_14', '30,000.00', 'IDFB6292M4509999', t0 + HOUR + 10 * 60_000);
    native.push(d1, 'ca_debit');
    native.push(c1, 'neft_confirm');
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1, enriched: 1 });
    native.push(d2, 'ca_debit');
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1 }); // D1 is already paired: D2 is new
    native.push(c2, 'neft_confirm');
    expect(await ingest(deps)).toEqual({ ...empty, enriched: 1 }); // pairs with D2, not D1
    const rows = await repo.listPending();
    expect(rows.map((r) => [r.id, r.utr, r.counterparty, r.mergedCount])).toEqual([
      [idOf(d1), 'IDFB6292M4509651', 'PERSON_13', 2],
      [idOf(d2), 'IDFB6292M4509999', 'PERSON_14', 2],
    ]);
  });

  it('only pending items within 7 days of the incoming SMS are correlation candidates', async () => {
    const { deps, native, repo } = await setup();
    const debit = fx('idfc-010'); // UTR IDFB6292M4509651
    native.push(debit, 'ca_debit');
    await ingest(deps);
    // Same UTR (correlate's UTR pass has no time window) but 10 days later: a separate item.
    native.push(at(fx('idfc-018'), debit.receivedAt + 10 * DAY), 'neft_confirm');
    expect(await ingest(deps)).toEqual({ ...empty, inserted: 1 });
    const rows = await repo.listPending();
    expect(rows.map((r) => r.mergedCount)).toEqual([1, 1]);
  });

  it('processes a batch oldest first (backfill returns newest first)', async () => {
    const { deps, native, repo } = await setup();
    const debit = shortDebit('30,000.00', fx('idfc-018').receivedAt - 20 * 60_000);
    native.inbox = [fx('idfc-018'), debit]; // newest first
    expect(await ensureBackfill(deps)).toMatchObject({ inserted: 1, enriched: 1 });
    expect((await repo.listPending()).map((r) => [r.id, r.kind])).toEqual([[idOf(debit), 'ca_debit']]);
  });
});

// ---------- backfill ----------

describe('ensureBackfill', () => {
  it('reads 7 days for the configured senders, goes through the same path, acks nothing and records the run', async () => {
    const { deps, native, repo } = await setup();
    native.inbox = [fx('idfc-001'), fx('idfc-033'), fx('synthetic-otp')];
    expect(await ensureBackfill(deps)).toEqual({ ...empty, inserted: 2, ignored: 1 });
    expect(native.backfillCalls).toEqual([[7, ['IDFCFB']]]);
    expect(native.acked).toEqual([]);
    expect(await repo.getSetting('backfill_done_at')).toBe(String(NOW));
    // Every app open runs it again; the overlap is harmless.
    expect(await ensureBackfill({ ...deps, now: () => NOW + HOUR })).toEqual({ ...empty, duplicates: 2, ignored: 1 });
    expect(await repo.getSetting('backfill_done_at')).toBe(String(NOW + HOUR));
  });

  it('reads the window from the backfill_days setting; unknown or missing values fall back to 7', async () => {
    const { deps, native, repo } = await setup();
    await repo.setSetting('backfill_days', '90');
    await ensureBackfill(deps, { fullWindow: true });
    await repo.setSetting('backfill_days', 'abc');
    await ensureBackfill(deps, { fullWindow: true });
    await repo.setSetting('backfill_days', '45');
    await ensureBackfill(deps, { fullWindow: true });
    await repo.setSetting('backfill_days', '180');
    await ensureBackfill(deps, { fullWindow: true });
    expect(native.backfillCalls.map((c) => c[0])).toEqual([90, 7, 7, 180]);
    expect(BACKFILL_CHOICES).toEqual([7, 30, 90, 180]);
    expect(DEFAULT_BACKFILL_DAYS).toBe(7);
    expect(BACKFILL_DAYS_KEY).toBe('backfill_days');
  });

  it('routine runs read 7 days after a recent run, more after a long gap, capped at the chosen window; a first run and fullWindow read it all', async () => {
    const { deps, native, repo } = await setup();
    const DAY = 86_400_000;
    await repo.setSetting('backfill_days', '90');
    await ensureBackfill(deps); // no backfill_done_at yet: full window
    await ensureBackfill({ ...deps, now: () => NOW + HOUR }); // recent
    await ensureBackfill({ ...deps, now: () => NOW + HOUR + 20 * DAY + HOUR }); // 20 days and 1h later
    await ensureBackfill({ ...deps, now: () => NOW + 500 * DAY }); // long gap, capped
    await ensureBackfill(deps, { fullWindow: true });
    expect(native.backfillCalls.map((c) => c[0])).toEqual([90, 7, 22, 90, 90]);
  });

  it('a larger window after items were answered creates no duplicates and reopens nothing', async () => {
    const { deps, native, repo } = await setup();
    native.inbox = [fx('idfc-001')];
    await ensureBackfill(deps);
    const [t] = await repo.listPending();
    await repo.upsertPending({ ...t, state: 'created' });
    await repo.setSetting('backfill_days', '180');
    native.inbox = [fx('idfc-001'), fx('idfc-002')];
    expect(await ensureBackfill(deps)).toEqual({ ...empty, inserted: 1, duplicates: 1 });
    const rows = await repo.listPending();
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === t.id)?.state).toBe('created');
  });

  it('the same SMS delivered live and via backfill is one txn (either order)', async () => {
    {
      const { deps, native, repo } = await setup();
      native.push(fx('idfc-001'));
      await ingest(deps);
      native.inbox = [fx('idfc-002'), fx('idfc-001')];
      expect(await ensureBackfill(deps)).toEqual({ ...empty, inserted: 1, duplicates: 1 });
      expect((await repo.listPending()).length).toBe(2);
    }
    {
      const { deps, native, repo } = await setup();
      native.inbox = [fx('idfc-001')];
      await ensureBackfill(deps);
      native.push(fx('idfc-001'));
      expect(await ingest(deps)).toEqual({ ...empty, duplicates: 1 });
      expect(native.queue).toEqual([]);
      expect((await repo.listPending()).length).toBe(1);
    }
  });

  it('a merged confirmation seen again via backfill stays merged (mergedCount unchanged)', async () => {
    const { deps, native, repo } = await setup();
    const debit = shortDebit('30,000.00', fx('idfc-018').receivedAt - 20 * 60_000);
    native.push(debit, 'ca_debit');
    native.push(fx('idfc-018'), 'neft_confirm');
    await ingest(deps);
    const before = await repo.listPending();
    native.inbox = [fx('idfc-018'), debit];
    expect(await ensureBackfill(deps)).toEqual({ ...empty, duplicates: 2 });
    expect(await repo.listPending()).toEqual(before);
    expect(before[0].mergedCount).toBe(2);
  });

  it('skips silently without READ_SMS', async () => {
    const { deps, native, repo } = await setup();
    native.perm = { receive: true, read: false, notifications: true };
    native.inbox = [fx('idfc-001')];
    expect(await ensureBackfill(deps)).toEqual({ ...empty, backfillSkipped: 'no_permission' });
    expect(native.backfillCalls).toEqual([]);
    expect(await repo.getSetting('backfill_done_at')).toBeNull();
  });

  it('skips when there are no mappings', async () => {
    const { deps, native } = await setup([]);
    expect(await ensureBackfill(deps)).toEqual({ ...empty, backfillSkipped: 'no_mappings' });
    expect(native.backfillCalls).toEqual([]);
  });
});

// ---------- foreground cycle ----------

class NoErp implements DrainErp {
  async findDraftsByUtr(_ref: string): Promise<{ doctype: string; name: string; docstatus: number }[]> { return []; }
  async getDraftSummary(): Promise<never> { throw new Error('unused'); }
  async createDraft(): Promise<{ name: string }> { throw new Error('unused'); }
  async deleteDraft() { /* unused */ }
  async searchParties() { return []; }
  async getDocStatuses() { return {}; }
  async createParty(): Promise<never> { throw new Error('unused'); }
  async checkSession() { return true; }
}

describe('runForegroundCycle', () => {
  it('runs sync -> ingest -> backfill -> drain and summarises', async () => {
    const { deps, native } = await setup();
    native.push(fx('idfc-001'));
    native.inbox = [fx('idfc-033')];
    const r = await runForegroundCycle({ ...deps, erp: new NoErp() });
    expect(native.log).toEqual(['setSenderPatterns', 'peek', 'ack', 'hasPermission', 'backfill']);
    expect(r).toEqual({
      senderPatterns: ['IDFCFB'],
      ingest: { ...empty, inserted: 1 },
      backfill: { ...empty, inserted: 1 },
      drain: { ran: 0, stoppedBecause: 'empty' },
      poll: { checked: 0, submitted: 0, cancelled: 0, missing: 0 },
      failedSteps: [],
      erpReached: true,
    });
  });

  it('a failing step never skips the rest', async () => {
    const { deps, native, repo } = await setup();
    native.setSenderPatterns = async () => { throw new Error('bridge'); };
    native.peek = async () => { throw new Error('bridge'); };
    native.inbox = [fx('idfc-033')];
    const nextOutbox = jest.fn(async () => null);
    const r = await runForegroundCycle({ ...deps, repo: { ...repo, nextOutbox }, native, erp: new NoErp() });
    expect(r.failedSteps).toEqual(['syncSenderPatterns', 'ingest']);
    expect(r.backfill).toEqual({ ...empty, inserted: 1 });
    expect(r.drain).toEqual({ ran: 0, stoppedBecause: 'empty' });
    expect(nextOutbox).toHaveBeenCalled();
  });

  it('backfill and drain failures are reported too', async () => {
    const { deps, native, repo } = await setup();
    native.hasPermission = async () => { throw new Error('bridge'); };
    const r = await runForegroundCycle({ ...deps, repo: { ...repo, nextOutbox: async () => { throw new Error('db'); } }, native, erp: new NoErp() });
    expect(r.failedSteps).toEqual(['ensureBackfill', 'drainOutbox']);
    expect(r.ingest).toEqual(empty);
  });
});

describe('runForegroundCycle: ERPNext round-trip (R50)', () => {
  const offline = () => { const e = new NoErp(); e.checkSession = async () => { throw new Error('offline'); }; return e; };

  it('offline with an empty outbox: no round-trip, erpReached false', async () => {
    const { deps } = await setup();
    const r = await runForegroundCycle({ ...deps, erp: offline() });
    expect(r.drain).toEqual({ ran: 0, stoppedBecause: 'empty' });
    expect(r.failedSteps).toEqual([]);
    expect(r.erpReached).toBe(false);
  });

  it('logged out with an empty outbox (checkSession false): erpReached false', async () => {
    const { deps } = await setup();
    const erp = new NoErp();
    erp.checkSession = async () => false;
    expect((await runForegroundCycle({ ...deps, erp })).erpReached).toBe(false);
  });

  it('online with an empty outbox: a final checkSession proves the round-trip', async () => {
    const { deps } = await setup();
    const erp = new NoErp();
    const spy = jest.spyOn(erp, 'checkSession');
    expect((await runForegroundCycle({ ...deps, erp })).erpReached).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a successful ERPNext call during the cycle counts; no extra checkSession', async () => {
    const { deps, repo } = await setup();
    await repo.upsertPending({
      id: 't-created', mergedCount: 1, state: 'created', createdDocs: [{ doctype: 'Payment Entry', name: 'PE-1', docstatus: 0 }], error: null,
      kind: 'ca_credit', direction: 'in', amountMinor: 100, currency: 'INR', occurredOn: '2026-01-02', occurredTime: null, accountType: 'bank',
      accountLast4: '6507', counterparty: null, utr: null, merchant: null, balanceMinor: null, sender: 'AX-IDFCFB', receivedAt: 1, rawHash: 'h-created',
    });
    const erp = offline();
    erp.getDocStatuses = async () => ({ 'Payment Entry:PE-1': 0 });
    const r = await runForegroundCycle({ ...deps, erp });
    expect(r.failedSteps).toEqual([]);
    expect(r.erpReached).toBe(true);
  });

  it('drain stopped on retry_later: erpReached false, checkSession not asked', async () => {
    const { deps, repo } = await setup();
    await repo.upsertPending({
      id: 't-q', mergedCount: 1, state: 'new', createdDocs: [], error: null,
      kind: 'ca_credit', direction: 'in', amountMinor: 100, currency: 'INR', occurredOn: '2026-01-02', occurredTime: null, accountType: 'bank',
      accountLast4: '6507', counterparty: null, utr: null, merchant: null, balanceMinor: null, sender: 'AX-IDFCFB', receivedAt: 1, rawHash: 'h-q',
    });
    const plan = { steps: [{ kind: 'create_doc' as const, doctype: 'Payment Entry', body: { reference_no: 'AL-q' } }], summary: [], needsInrAmount: false };
    await repo.enqueue({ id: outboxIdFor('t-q', plan), txnId: 't-q', plan, progress: { stepIndex: 0, created: [] }, attempts: 0, status: 'pending' });
    const erp = new NoErp();
    erp.findDraftsByUtr = async () => { throw new ErpNetworkError('offline'); };
    const spy = jest.spyOn(erp, 'checkSession');
    const r = await runForegroundCycle({ ...deps, erp });
    expect(r.drain).toEqual({ ran: 1, stoppedBecause: 'retry_later' });
    expect(r.erpReached).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('a cycle with failed steps does not ask checkSession', async () => {
    const { deps, native } = await setup();
    native.peek = async () => { throw new Error('bridge'); };
    const erp = new NoErp();
    const spy = jest.spyOn(erp, 'checkSession');
    const r = await runForegroundCycle({ ...deps, native, erp });
    expect(r.failedSteps).toEqual(['ingest']);
    expect(r.erpReached).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
