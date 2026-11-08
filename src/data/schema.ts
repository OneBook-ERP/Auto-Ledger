// Local SQLite schema + versioned migrations. Money is stored as INTEGER minor units.
// Arrays/objects are stored as JSON text columns.

export interface SqlDriver {
  exec(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

const V1: string[] = [
  `CREATE TABLE IF NOT EXISTS pending_txn (
    id TEXT PRIMARY KEY NOT NULL,
    raw_hash TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    merged_count INTEGER NOT NULL DEFAULT 1,
    created_docs TEXT NOT NULL DEFAULT '[]',
    error TEXT,
    kind TEXT NOT NULL,
    direction TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency TEXT NOT NULL,
    occurred_on TEXT NOT NULL,
    occurred_time TEXT,
    account_type TEXT NOT NULL,
    account_last4 TEXT,
    counterparty TEXT,
    utr TEXT,
    merchant TEXT,
    balance_minor INTEGER,
    sender TEXT NOT NULL,
    received_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS account_mapping (
    bank_account TEXT PRIMARY KEY NOT NULL,
    gl_account TEXT NOT NULL,
    kind TEXT NOT NULL,
    sender_ids TEXT NOT NULL DEFAULT '[]',
    last4 TEXT NOT NULL DEFAULT '[]',
    mode_of_payment TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rule (
    match_key TEXT PRIMARY KEY NOT NULL,
    action TEXT NOT NULL,
    party TEXT,
    account TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    last_used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS outbox (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    txn_id TEXT NOT NULL,
    plan TEXT NOT NULL,
    progress TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)`,
];

const V2: string[] = [
  `CREATE INDEX IF NOT EXISTS idx_pending_state ON pending_txn (state)`,
];

// MIGRATIONS[i] upgrades schema version i to i+1.
export const MIGRATIONS: string[][] = [V1, V2];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Apply pending migrations up to `target` (default: latest). Idempotent. */
export async function migrate(d: SqlDriver, target: number = SCHEMA_VERSION): Promise<void> {
  await d.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const rows = await d.all<{ version: number }>('SELECT version FROM schema_version');
  let current = rows.length ? rows[0].version : 0;
  if (!rows.length) await d.exec('INSERT INTO schema_version (version) VALUES (0)');
  while (current < target) {
    // Each step (its DDL and the version bump) is atomic; SQLite DDL is transactional.
    await d.exec('BEGIN');
    try {
      for (const stmt of MIGRATIONS[current]) await d.exec(stmt);
      await d.exec('UPDATE schema_version SET version = ?', [current + 1]);
      await d.exec('COMMIT');
    } catch (e) {
      try { await d.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
    current += 1;
  }
}
