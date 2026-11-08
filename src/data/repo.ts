import type { PendingTxn, AccountMapping, Rule, OutboxOp } from '../core/types';
import { migrate, type SqlDriver } from './schema';

export type { SqlDriver } from './schema';

export interface Repo {
  listPending(state?: PendingTxn['state']): Promise<PendingTxn[]>;
  /** Idempotent on rawHash: if a row with the same rawHash exists (even under a
   *  different id) that row is UPDATED in place and keeps its original id; no
   *  second row is created. Otherwise upserts by id. */
  upsertPending(t: PendingTxn): Promise<void>;
  getPending(id: string): Promise<PendingTxn | null>;
  saveMapping(m: AccountMapping): Promise<void>;
  listMappings(): Promise<AccountMapping[]>;
  saveRule(r: Rule): Promise<void>;
  listRules(): Promise<Rule[]>;
  enqueue(op: OutboxOp): Promise<void>;
  nextOutbox(): Promise<OutboxOp | null>;
  markOutbox(id: string, patch: Partial<Pick<OutboxOp, 'progress' | 'attempts' | 'status'>>): Promise<void>;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
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
  id: r.id, mergedCount: r.merged_count, state: r.state, createdDocs: JSON.parse(r.created_docs),
  error: r.error, kind: r.kind, direction: r.direction, amountMinor: r.amount_minor,
  currency: r.currency, occurredOn: r.occurred_on, occurredTime: r.occurred_time,
  accountType: r.account_type, accountLast4: r.account_last4, counterparty: r.counterparty,
  utr: r.utr, merchant: r.merchant, balanceMinor: r.balance_minor, sender: r.sender,
  receivedAt: r.received_at, rawHash: r.raw_hash,
});

const PENDING_COLS = `id, raw_hash, state, merged_count, created_docs, error, kind, direction,
  amount_minor, currency, occurred_on, occurred_time, account_type, account_last4, counterparty,
  utr, merchant, balance_minor, sender, received_at`;

export async function createRepo(d: SqlDriver): Promise<Repo> {
  await migrate(d);

  return {
    async listPending(state) {
      const rows = state
        ? await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn WHERE state = ? ORDER BY received_at, id`, [state])
        : await d.all<PendingRow>(`SELECT ${PENDING_COLS} FROM pending_txn ORDER BY received_at, id`);
      return rows.map(toPending);
    },
    async upsertPending(t) {
      const existing = await d.all<{ id: string }>('SELECT id FROM pending_txn WHERE raw_hash = ?', [t.rawHash]);
      const id = existing.length ? existing[0].id : t.id;
      await d.exec(
        `INSERT INTO pending_txn (${PENDING_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET raw_hash=excluded.raw_hash, state=excluded.state,
           merged_count=excluded.merged_count, created_docs=excluded.created_docs, error=excluded.error,
           kind=excluded.kind, direction=excluded.direction, amount_minor=excluded.amount_minor,
           currency=excluded.currency, occurred_on=excluded.occurred_on, occurred_time=excluded.occurred_time,
           account_type=excluded.account_type, account_last4=excluded.account_last4,
           counterparty=excluded.counterparty, utr=excluded.utr, merchant=excluded.merchant,
           balance_minor=excluded.balance_minor, sender=excluded.sender, received_at=excluded.received_at`,
        [id, t.rawHash, t.state, t.mergedCount, JSON.stringify(t.createdDocs), t.error, t.kind, t.direction,
          t.amountMinor, t.currency, t.occurredOn, t.occurredTime, t.accountType, t.accountLast4,
          t.counterparty, t.utr, t.merchant, t.balanceMinor, t.sender, t.receivedAt],
      );
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
        senderIds: JSON.parse(r.sender_ids), last4: JSON.parse(r.last4), modeOfPayment: r.mode_of_payment,
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
        if (r.party) rule.party = JSON.parse(r.party);
        if (r.account !== null) rule.account = r.account;
        return rule;
      });
    },
    async enqueue(op) {
      await d.exec(
        'INSERT INTO outbox (id, txn_id, plan, progress, attempts, status) VALUES (?,?,?,?,?,?)',
        [op.id, op.txnId, JSON.stringify(op.plan), JSON.stringify(op.progress), op.attempts, op.status],
      );
    },
    async nextOutbox() {
      const rows = await d.all<{ id: string; txn_id: string; plan: string; progress: string; attempts: number; status: OutboxOp['status'] }>(
        `SELECT id, txn_id, plan, progress, attempts, status FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT 1`);
      if (!rows.length) return null;
      const r = rows[0];
      return { id: r.id, txnId: r.txn_id, plan: JSON.parse(r.plan), progress: JSON.parse(r.progress), attempts: r.attempts, status: r.status };
    },
    async markOutbox(id, patch) {
      const sets: string[] = []; const params: unknown[] = [];
      if (patch.progress !== undefined) { sets.push('progress = ?'); params.push(JSON.stringify(patch.progress)); }
      if (patch.attempts !== undefined) { sets.push('attempts = ?'); params.push(patch.attempts); }
      if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
      if (!sets.length) return;
      await d.exec(`UPDATE outbox SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
    },
    async getSetting(key) {
      const rows = await d.all<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
      return rows.length ? rows[0].value : null;
    },
    async setSetting(key, value) {
      await d.exec('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
    },
  };
}
