import { createRepo } from '../data/repo';
import { createTestDriver } from '../data/testDriver';
import { maybeRefreshTemplates, TEMPLATES_CHECKED_AT_KEY } from './templatesSchedule';

const DAY = 24 * 3600_000;
const mk = async () => createRepo(createTestDriver());
const native = { setTemplates: jest.fn(async () => true) };

describe('maybeRefreshTemplates', () => {
  it('skips silently when the URL is empty (no fetch, nothing stored)', async () => {
    const repo = await mk();
    const fetchImpl = jest.fn();
    expect(await maybeRefreshTemplates({ url: '', repo, native, now: () => 1000, fetchImpl: fetchImpl as never })).toBe('skipped');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await repo.getSetting(TEMPLATES_CHECKED_AT_KEY)).toBeNull();
  });
  it('runs at most once per 24 hours', async () => {
    const repo = await mk();
    const fetchImpl = jest.fn(async () => new Response('not json', { status: 200 }));
    const base = { url: 'https://t.example/idfc.json', repo, native, fetchImpl: fetchImpl as never };
    expect(await maybeRefreshTemplates({ ...base, now: () => 10 * DAY })).toBe('failed');
    expect(await repo.getSetting(TEMPLATES_CHECKED_AT_KEY)).toBe(String(10 * DAY));
    expect(await maybeRefreshTemplates({ ...base, now: () => 10 * DAY + DAY - 1 })).toBe('skipped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await maybeRefreshTemplates({ ...base, now: () => 11 * DAY })).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
