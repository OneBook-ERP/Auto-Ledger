import type { PendingTxn, ParsedTxn, AccountMapping, Rule, OutboxOp } from '../core/types';
import { migrate, type SqlDriver } from './schema';

export type { SqlDriver } from './schema';

export interface Repo {
  listPending(state?: PendingTxn['state']): Promise<PendingTxn[]>;
  /** Same id: the row is replaced (normal update). Different id but an existing
   *  rawHash: the existing row is left completely untouched (re-delivery of an
   *  SMS must not reset state/createdDocs). Single statement, so concurrent
   *  callers cannot hit a UNIQUE violation. */
  upsertPending(t: PendingTxn): Promise<void>;
  getPending(id: string): Promise<PendingTxn | null>;
  /** Correlation write (Task 15), one transaction: unless SMS `sourceRawHash` was merged before ('already'),
   *  applies `patch` to txn `targetId` (never its id, rawHash, state, createdDocs, error), increments its
   *  mergedCount and records the source SMS (setting `merged_sms:<hash>` = targetId). When the target's
   *  state is not 'new' only `utr` and `counterparty` are taken from the patch. Re-reads the row
   *  under the lock, so a concurrent state change is never overwritten. */
  mergeInto(targetId: string, patch: Partial<ParsedTxn>, sourceRawHash: string): Promise<
    { status: 'merged'; txn: PendingTxn } | { status: 'already' | 'missing' }>;
  /** True when SMS `rawHash` was merged into another txn by mergeInto. */
  isMergedSms(rawHash: string): Promise<boolean>;
  saveMapping(m: AccountMapping): Promise<void>;
  listMappings(): Promise<AccountMapping[]>;
  saveRule(r: Rule): Promise<void>;
  listRules(): Promise<Rule[]>;
  /** Inserts `op` and, in the same transaction, marks every OTHER pending item of op.txnId 'superseded'. */
  enqueue(op: OutboxOp): Promise<void>;
  nextOutbox(): Promise<OutboxOp | null>;
  /** The outbox item with this id, or null (also null when its stored JSON is unreadable). */
  getOutbox(id: string): Promise<OutboxOp | null>;
  /** Marks every OTHER pending item of `txnId` 'superseded' (the user made a newer decision). */
  supersedePending(txnId: string, exceptId: string): Promise<void>;
  /** Sets item `id` back to 'pending' and supersedes the other pending items of its txn, in one transaction. */
  reopenOutbox(id: string): Promise<void>;
  /** Every readable outbox item of `txnId`, oldest first. */
  listOutbox(txnId: string): Promise<OutboxOp[]>;
  markOutbox(id: string, patch: Partial<Pick<OutboxOp, 'progress' | 'attempts' | 'status'>>): Promise<void>;
  /** One statement: writes `progress` and sets status 'done' unless the item is already 'superseded'. */
  finishOutbox(id: string, progress: OutboxOp['progress']): Promise<void>;
  /** One transaction: deletes mappings, rules, pending txns, outbox rows and every setting (including the
   *  `merged_sms:*` markers) except the template-set cache (`templates_*`, not site data). Used when the user
   *  signs in to a different ERPNext site, so nothing of the old books can reach the new one. */
  resetForNewSite(): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  /** Every setting whose key starts with `prefix` (plain prefix, no wildcards), ordered by key. */
  listSettings(prefix: string): Promise<{ key: string; value: string }[]>;
  /** Removes one setting (no-op when absent). */
  deleteSetting(key: string): Promise<void>;
}

type PendingRow = {
  id: string; raw_hash: string; state: PendingTxn['state']; merged_count: number;
  created_docs: string; error: string | null; kind: PendingTxn['kind']; direction: 'in' | 'out';
  amount_minor: number; currency: string; occurred_on: string; occurred_time: string | null;
  account_type: 'bank' | 'card'; account_last4: string | null; counterparty: string | null;
  utr: string | null; merchant: string | null; balance_minor: number | null; sender: string;
  received_at: number;
};

const toPending = (r: PendingRow): PendingTxn => ({
  id: r.id, mergedCount: r.merged_count, state: r.state, createdDocs: safeParse(r.created_docs, []),
  error: r.error, kind: r.kind, direction: r.direction, amountMinor: r.amount_minor,
  currency: r.currency, occurredOn: r.occurred_on, occurredTime: r.occurred_time,
  accountType: r.account_type, accountLast4: r.account_last4, counterparty: r.counterparty,
  utr: r.utr, merchant: r.merchant, balanceMinor: r.balance_minor, sender: r.sender,
  receivedAt: r.received_at, rawHash: r.raw_hash,
});

const PENDING_COLS = `id, raw_hash, state, merged_count, created_docs, error, kind, direction,
  amount_minor, currency, occurred_on, occurred_time, account_type, account_last4, counterparty,
  utr, merchant, balance_minor, sender, received_at`;

const FAIL = Symbol('parse-fail');
const MERGED_PREFIX = 'merged_sms:';

type OutboxRow = { id: string; txn_id: string; plan: string; progress: string; attempts: number; status: OutboxOp['status'] };
function toOutbox(r: OutboxRow): OutboxOp | null {
  const plan = safeParse<OutboxOp['plan'] | typeof FAIL>(r.plan, FAIL);
  const progress = safeParse<OutboxOp['progress'] | typeof FAIL>(r.progress, FAIL);
  if (plan === FAIL || progress === FAIL || plan === null || progress === null) return null;
  return { id: r.id, txnId: r.txn_id, plan, progress, attempts: r.attempts, status: r.status };
}
function safeParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

/** Async mutex: runs tasks one at a time, in call order; a failing task never blocks the next. */
function createMutex() {
  let tail: Promise<void> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

export async function createRepo(d: SqlDriver): Promise<Repo> {
  await migrate(d);
  // The app has ONE SQLite connection. Every Repo method runs under this mutex so that statements of
  // different callers never interleave, in particular never inside another caller's BEGIN..COMMIT.
  // Methods only use the raw driver `d` (never other Repo methods), so holding the lock cannot deadlock.
  const exclusive = createMutex();

  async function inTransaction(fn: () => Promise<void>): Promise<void> {
    await d.exec('BEGIN');
    try {
      await fn();
      await d.exec('COMMIT');
    } catch (e) {
      try { await d.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  }

  async function writePending(t: PendingTxn): Promise<void> {
    await d.exec(
      `INSERT INTO pending_txn (${PENDING_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET raw_hash=excluded.raw_hash, state=excluded.state,
         merged_count=excluded.merged_count, created_docs=excluded.created_docs, error=excluded.error,
         kind=excluded.kind, direction=excluded.direction, amount_minor=excluded.amount_minor,
         currency=excluded.currency, occurred_on=excluded.occurred_on, occurred_time=excluded.occurred_time,
         account_type=excluded.account_type, account_last4=excluded.account_last4,
         counterparty=excluded.counterparty, utr=excluded.utr, merchant=excluded.merchant,
         balance_minor=excluded.balance_minor, sender=excluded.sender, received_at=excluded.received_at
       ON CONFLICT(raw_hash) DO NOTHING`,
      [t.id, t.rawHash, t.state, t.mergedCount, JSON.stringify(t.createdDocs), t.error, t.kind, t.direction,
        t.amountMinor, t.currency, t.occurredOn, t.occurredTime, t.accountType, t.accountLast4,
        t.counterparty, t.utr, t.merchant, t.balanceMinor, t.sender, t.receivedAt],
    );
  }

  const impl: Repo = {
    async listPending(state) {
      const rows = state
        ? await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn WHERE state = ? ORDER BY received_at, id`, [state])
        : await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn ORDER BY received_at, id`);
      return rows.map(toPending);
    },
    async upsertPending(t) {
      await writePending(t);
    },
    async mergeInto(targetId, patch, sourceRawHash) {
      let out: { status: 'merged'; txn: PendingTxn } | { status: 'already' | 'missing' } = { status: 'missing' };
      await inTransaction(async () => {
        const seen = await d.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [MERGED_PREFIX + sourceRawHash]);
        if (seen.length) { out = { status: 'already' }; return; }
        const rows = await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn WHERE id = ?`, [targetId]);
        if (!rows.length) { out = { status: 'missing' }; return; }
        const cur = toPending(rows[0]);
        const { id: _i, rawHash: _h, state: _s, createdDocs: _c, error: _e, mergedCount: _m, ...fields } =
          patch as Partial<PendingTxn>;
        // A handled txn keeps what was posted: only the identifying utr/counterparty may still be filled in.
        const allowed: Partial<ParsedTxn> = cur.state === 'new' ? fields : {
          ...(fields.utr !== undefined ? { utr: fields.utr } : {}),
          ...(fields.counterparty !== undefined ? { counterparty: fields.counterparty } : {}),
        };
        const next: PendingTxn = { ...cur, ...allowed, mergedCount: cur.mergedCount + 1 };
        await writePending(next);
        await d.exec('INSERT INTO settings (key, value) VALUES (?,?)', [MERGED_PREFIX + sourceRawHash, targetId]);
        out = { status: 'merged', txn: next };
      });
      return out;
    },
    async isMergedSms(rawHash) {
      const rows = await d.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [MERGED_PREFIX + rawHash]);
      return rows.length > 0;
    },
    async getPending(id) {
      const rows = await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn WHERE id = ?`, [id]);
      return rows.length ? toPending(rows[0]) : null;
    },
    async saveMapping(m) {
      await d.exec(
        `INSERT INTO account_mapping (bank_account, gl_account, kind, sender_ids, last4, mode_of_payment)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(bank_account) DO UPDATE SET gl_account=excluded.gl_account, kind=excluded.kind,
           sender_ids=excluded.sender_ids, last4=excluded.last4, mode_of_payment=excluded.mode_of_payment`,
        [m.bankAccount, m.glAccount, m.kind, JSON.stringify(m.senderIds), JSON.stringify(m.last4), m.modeOfPayment],
      );
    },
    async listMappings() {
      const rows = await d.all<{ bank_account: string; gl_account: string; kind: 'bank' | 'card'; sender_ids: string; last4: string; mode_of_payment: string }>(
        'SELECT * FROM account_mapping ORDER BY bank_account');
      return rows.map((r) => ({
        bankAccount: r.bank_account, glAccount: r.gl_account, kind: r.kind,
        senderIds: safeParse(r.sender_ids, []), last4: safeParse(r.last4, []), modeOfPayment: r.mode_of_payment,
      }));
    },
    async saveRule(r) {
      await d.exec(
        `INSERT INTO rule (match_key, action, party, account, hits, last_used) VALUES (?,?,?,?,?,?)
         ON CONFLICT(match_key) DO UPDATE SET action=excluded.action, party=excluded.party,
           account=excluded.account, hits=excluded.hits, last_used=excluded.last_used`,
        [r.matchKey, r.action, r.party ? JSON.stringify(r.party) : null, r.account ?? null, r.hits, r.lastUsed],
      );
    },
    async listRules() {
      const rows = await d.all<{ match_key: string; action: Rule['action']; party: string | null; account: string | null; hits: number; last_used: number }>(
        'SELECT * FROM rule ORDER BY match_key');
      return rows.map((r) => {
        const rule: Rule = { matchKey: r.match_key, action: r.action, hits: r.hits, lastUsed: r.last_used };
        const party = r.party ? safeParse<Rule['party'] | null>(r.party, null) : null;
        if (party) rule.party = party;
        if (r.account !== null) rule.account = r.account;
        return rule;
      });
    },
    async enqueue(op) {
      await inTransaction(async () => {
        await d.exec(
          'INSERT INTO outbox (id, txn_id, plan, progress, attempts, status) VALUES (?,?,?,?,?,?)',
          [op.id, op.txnId, JSON.stringify(op.plan), JSON.stringify(op.progress), op.attempts, op.status],
        );
        await d.exec(`UPDATE outbox SET status = 'superseded' WHERE txn_id = ? AND id != ? AND status = 'pending'`, [op.txnId, op.id]);
      });
    },
    async reopenOutbox(id) {
      await inTransaction(async () => {
        await d.exec(
          `UPDATE outbox SET status = 'superseded'
           WHERE txn_id = (SELECT txn_id FROM outbox WHERE id = ?) AND id != ? AND status = 'pending'`,
          [id, id],
        );
        await d.exec(`UPDATE outbox SET status = 'pending' WHERE id = ?`, [id]);
      });
    },
    async listOutbox(txnId) {
      const rows = await d.all<OutboxRow>('SELECT id, txn_id, plan, progress, attempts, status FROM outbox WHERE txn_id = ? ORDER BY seq', [txnId]);
      return rows.map(toOutbox).filter((o): o is OutboxOp => o !== null);
    },
    async getOutbox(id) {
      const rows = await d.all<OutboxRow>('SELECT id, txn_id, plan, progress, attempts, status FROM outbox WHERE id = ?', [id]);
      return rows.length ? toOutbox(rows[0]) : null;
    },
    async supersedePending(txnId, exceptId) {
      await d.exec(`UPDATE outbox SET status = 'superseded' WHERE txn_id = ? AND id != ? AND status = 'pending'`, [txnId, exceptId]);
    },
    async nextOutbox() {
      for (;;) {
        const rows = await d.all<OutboxRow>(
          `SELECT id, txn_id, plan, progress, attempts, status FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT 1`);
        if (!rows.length) return null;
        const op = toOutbox(rows[0]);
        if (!op) {
          await d.exec(`UPDATE outbox SET status = 'failed' WHERE id = ?`, [rows[0].id]);
          continue;
        }
        return op;
      }
    },
    async finishOutbox(id, progress) {
      await d.exec(
        `UPDATE outbox SET progress = ?, status = CASE WHEN status = 'superseded' THEN status ELSE 'done' END WHERE id = ?`,
        [JSON.stringify(progress), id],
      );
    },
    async markOutbox(id, patch) {
      const sets: string[] = []; const params: unknown[] = [];
      if (patch.progress !== undefined) { sets.push('progress = ?'); params.push(JSON.stringify(patch.progress)); }
      if (patch.attempts !== undefined) { sets.push('attempts = ?'); params.push(patch.attempts); }
      if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
      if (!sets.length) return;
      await d.exec(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    },
    async resetForNewSite() {
      await inTransaction(async () => {
        for (const t of ['pending_txn', 'account_mapping', 'rule', 'outbox']) await d.exec(`DELETE FROM ${t}`);
        await d.exec("DELETE FROM settings WHERE key NOT LIKE 'templates\\_%' ESCAPE '\\'");
      });
    },
    async getSetting(key) {
      const rows = await d.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
      return rows.length ? rows[0].value : null;
    },
    async setSetting(key, value) {
      await d.exec('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
    },
    async listSettings(prefix) {
      // substr comparison instead of LIKE, so '_' and '%' in the prefix are literal.
      return d.all<{ key: string; value: string }>(
        'SELECT key, value FROM settings WHERE substr(key, 1, ?) = ? ORDER BY key', [prefix.length, prefix]);
    },
    async deleteSetting(key) {
      await d.exec('DELETE FROM settings WHERE key = ?', [key]);
    },
  };

  const locked = {} as Record<string, unknown>;
  for (const [k, fn] of Object.entries(impl) as [string, (...a: unknown[]) => Promise<unknown>][]) {
    locked[k] = (...args: unknown[]) => exclusive(() => fn(...args));
  }
  return locked as unknown as Repo;
}
