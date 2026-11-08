// Test-only SqlDriver over better-sqlite3 (in-memory). Not imported by app code.
import Database from 'better-sqlite3';
import type { SqlDriver } from './schema';

export function createTestDriver(): SqlDriver {
  const db = new Database(':memory:');
  return {
    async exec(sql, params) {
      if (params && params.length) db.prepare(sql).run(...(params as unknown[]));
      else db.exec(sql);
    },
    async all<T>(sql: string, params?: unknown[]) {
      return db.prepare(sql).all(...((params ?? []) as unknown[])) as T[];
    },
  };
}
