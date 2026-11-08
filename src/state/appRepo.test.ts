jest.mock('../data/expoDriver', () => ({ openExpoDriver: jest.fn() }));
import { createTestDriver } from '../data/testDriver';
import { createAppRepo, getAppRepo, resetAppRepoForTests } from './appRepo';

beforeEach(() => resetAppRepoForTests());

describe('single app-wide Repo', () => {
  it('creating a second Repo throws in dev', async () => {
    expect((globalThis as { __DEV__?: boolean }).__DEV__).toBe(true);
    await createAppRepo(async () => createTestDriver());
    await expect(createAppRepo(async () => createTestDriver())).rejects.toThrow(/created twice/);
  });
  it('getAppRepo opens the driver once and always returns the same instance', async () => {
    const open = jest.fn(async () => createTestDriver());
    const [a, b] = await Promise.all([getAppRepo(open), getAppRepo(open)]);
    expect(a).toBe(b);
    expect(await getAppRepo(open)).toBe(a);
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('a second creation in release returns the first instance instead of throwing', async () => {
    const first = await createAppRepo(async () => createTestDriver());
    const g = globalThis as { __DEV__?: boolean };
    g.__DEV__ = false;
    try {
      expect(await createAppRepo(async () => createTestDriver())).toBe(first);
    } finally {
      g.__DEV__ = true;
    }
  });
});
