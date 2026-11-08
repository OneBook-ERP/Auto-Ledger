// Thin SqlDriver adapter over expo-sqlite's async API. Compile-checked only.
import * as SQLite from 'expo-sqlite';
import type { SqlDriver } from './schema';

export async function openExpoDriver(name = 'autoledger.db'): Promise<SqlDriver> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync('PRAGMA journal_mode = WAL;');
  return {
    async exec(sql, params) {
      if (params && params.length) await db.runAsync(sql, params as SQLite.SQLiteBindValue[]);
      else await db.execAsync(sql);
    },
    async all<T>(sql: string, params?: unknown[]) {
      return db.getAllAsync<T>(sql, (params ?? []) as SQLite.SQLiteBindValue[]);
    },
  };
}
