// The ONE Repo of the app. The Repo's mutex (and the ingest/drain locks) are per instance, so a second
// instance on the same SQLite connection would defeat them: creating one twice throws in dev.
import { createRepo, type Repo, type SqlDriver } from '../data/repo';

type Open = () => Promise<SqlDriver>;

// expo-sqlite is required lazily: importing it must not happen (or fail) at module load.
const openExpoDriver: Open = () => (require('../data/expoDriver') as typeof import('../data/expoDriver')).openExpoDriver();

let created: Promise<Repo> | null = null;

export function createAppRepo(open: Open = openExpoDriver): Promise<Repo> {
  if (created) {
    if (__DEV__) return Promise.reject(new Error('The app Repo was created twice: share the instance from AppProvider instead.'));
    return created;
  }
  created = open().then(createRepo);
  created.catch(() => {
    created = null; // allow a retry after a failed open
  });
  return created;
}

/** Idempotent accessor used by the provider (survives remounts and double effects). */
export function getAppRepo(open: Open = openExpoDriver): Promise<Repo> {
  return created ?? createAppRepo(open);
}

export function resetAppRepoForTests(): void {
  created = null;
}
