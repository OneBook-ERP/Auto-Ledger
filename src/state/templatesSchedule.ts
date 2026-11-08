import type { Repo } from '../data/repo';
import { refreshTemplates } from '../ingest/templates';

export const TEMPLATES_CHECKED_AT_KEY = 'templates_checked_at';
export const TEMPLATES_CHECK_INTERVAL_MS = 24 * 3600_000;

/**
 * Template refresh on its own schedule: at most once per 24 h (persisted), and silently skipped when no
 * URL is configured. The attempt time is stored before fetching so a failing host is not hammered.
 */
export async function maybeRefreshTemplates(deps: {
  url: string;
  repo: Repo;
  native: { setTemplates(json: string): Promise<boolean> };
  now: () => number;
  fetchImpl?: typeof fetch;
}): Promise<'skipped' | 'updated' | 'unchanged' | 'failed'> {
  if (!deps.url) return 'skipped';
  const last = Number(await deps.repo.getSetting(TEMPLATES_CHECKED_AT_KEY));
  const now = deps.now();
  if (Number.isFinite(last) && last > 0 && now - last < TEMPLATES_CHECK_INTERVAL_MS) return 'skipped';
  await deps.repo.setSetting(TEMPLATES_CHECKED_AT_KEY, String(now));
  return refreshTemplates({ url: deps.url, repo: deps.repo, native: deps.native, fetchImpl: deps.fetchImpl });
}
