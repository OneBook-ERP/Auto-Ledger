import { afterCycle, afterCycleBackground, createCycleRunner } from './cycle';
import { LAST_SYNCED_KEY } from '../home/viewModel';

const deferred = () => {
  let resolve!: (v: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe('cycle runner', () => {
  it('never overlaps: a call while a cycle is running joins it', async () => {
    const d = deferred();
    const run = jest.fn(() => d.promise as Promise<never>);
    const after = jest.fn(async () => undefined);
    const r = createCycleRunner({ run: run as never, after });
    const p1 = r.trigger();
    const p2 = r.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    d.resolve({ failedSteps: [] });
    await Promise.all([p1, p2]);
    expect(after).toHaveBeenCalledTimes(1);
    await r.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('a failing cycle frees the runner and never rejects', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ failedSteps: [] });
    const r = createCycleRunner({ run, after: async () => undefined });
    await expect(r.trigger()).resolves.toBeUndefined();
    await r.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('attachAppStateCycle', () => {
  it('runs the cycle when AppState becomes active, one at a time', async () => {
    const listeners: ((s: string) => void)[] = [];
    const { attachAppStateCycle } = require('./cycle');
    const d = deferred();
    const run = jest.fn(() => d.promise);
    const runner = createCycleRunner({ run: run as never, after: async () => undefined });
    const detach = attachAppStateCycle(runner, {
      addEventListener: (_t: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return { remove: jest.fn() };
      },
    });
    listeners[0]('background');
    expect(run).not.toHaveBeenCalled();
    listeners[0]('active');
    listeners[0]('active');
    expect(run).toHaveBeenCalledTimes(1);
    d.resolve({ failedSteps: [] });
    detach();
  });
});

describe('afterCycle (R50)', () => {
  const synced = { failedSteps: [], drain: { ran: 0, stoppedBecause: 'empty' as const }, erpReached: true };
  const deps = () => {
    const settings = new Map<string, string>();
    return {
      settings,
      repo: { setSetting: jest.fn(async (k: string, v: string) => void settings.set(k, v)) },
      now: () => 1234,
      refreshBanners: jest.fn(async () => undefined),
      invalidateHome: jest.fn(),
    };
  };

  it('records last_synced_at only for a cycle that reached ERPNext', async () => {
    const d = deps();
    await afterCycle(synced, d);
    expect(d.settings.get(LAST_SYNCED_KEY)).toBe('1234');
    const off = deps();
    await afterCycle({ ...synced, erpReached: false }, off);
    expect(off.settings.has(LAST_SYNCED_KEY)).toBe(false);
    expect(off.invalidateHome).toHaveBeenCalledTimes(1);
  });

  it('invalidates Home even when refreshBanners rejects', async () => {
    const d = deps();
    d.refreshBanners.mockRejectedValueOnce(new Error('db'));
    await expect(afterCycle(synced, d)).rejects.toThrow('db');
    expect(d.invalidateHome).toHaveBeenCalledTimes(1);
  });

  it('invalidates Home when the sync-time write fails, and a failed cycle (null) too', async () => {
    const d = deps();
    d.repo.setSetting.mockRejectedValueOnce(new Error('disk'));
    await afterCycle(synced, d);
    expect(d.refreshBanners).toHaveBeenCalled();
    expect(d.invalidateHome).toHaveBeenCalledTimes(1);
    const n = deps();
    await afterCycle(null, n);
    expect(n.repo.setSetting).not.toHaveBeenCalled();
    expect(n.invalidateHome).toHaveBeenCalledTimes(1);
  });

  it('through the runner: a rejecting refreshBanners still invalidates Home and the trigger resolves', async () => {
    const d = deps();
    d.refreshBanners.mockRejectedValue(new Error('db'));
    const r = createCycleRunner({ run: async () => synced, after: (s) => afterCycle(s, d) });
    await expect(r.trigger()).resolves.toBeUndefined();
    expect(d.invalidateHome).toHaveBeenCalledTimes(1);
  });
});

describe('afterCycle: possible-duplicate check', () => {
  const synced = { failedSteps: [], drain: { ran: 0, stoppedBecause: 'empty' as const }, erpReached: true };
  const deps = () => ({
    repo: { setSetting: jest.fn(async () => undefined) },
    now: () => 1,
    refreshBanners: jest.fn(async () => undefined),
    invalidateHome: jest.fn(),
    checkDuplicates: jest.fn(async () => undefined),
  });

  it('runs once when ERPNext answered during the cycle', async () => {
    const d = deps();
    await afterCycle(synced, d);
    expect(d.checkDuplicates).toHaveBeenCalledTimes(1);
  });

  it('does not run when ERPNext did not answer, the cycle failed or was skipped', async () => {
    const d = deps();
    await afterCycle({ ...synced, erpReached: false }, d);
    await afterCycle(null, d);
    await afterCycle({ failedSteps: [], skipped: 'site_mismatch' }, d);
    expect(d.checkDuplicates).not.toHaveBeenCalled();
  });

  it('a failing check never blocks the cycle and Home is still invalidated', async () => {
    const d = deps();
    d.checkDuplicates.mockRejectedValueOnce(new Error('offline'));
    await expect(afterCycle(synced, d)).resolves.toBeUndefined();
    expect(d.invalidateHome).toHaveBeenCalledTimes(1);
  });

  it('runs even when the banner refresh rejects', async () => {
    const d = deps();
    d.refreshBanners.mockRejectedValueOnce(new Error('db'));
    await expect(afterCycle(synced, d)).rejects.toThrow('db');
    expect(d.checkDuplicates).toHaveBeenCalledTimes(1);
  });
});

describe('afterCycle: automatic answers', () => {
  const synced = { failedSteps: [], drain: { ran: 0, stoppedBecause: 'empty' as const }, erpReached: true };
  const deps = () => {
    const order: string[] = [];
    return {
      order,
      repo: { setSetting: jest.fn(async () => undefined) },
      now: () => 1,
      refreshBanners: jest.fn(async () => undefined),
      invalidateHome: jest.fn(() => { order.push('home'); }),
      checkDuplicates: jest.fn(async (): Promise<boolean> => { order.push('dup'); return true; }),
      autoApply: jest.fn(async () => { order.push('auto'); return 0; }),
    };
  };

  it('runs after the duplicate check (fresh warnings) and only when ERPNext answered', async () => {
    const d = deps();
    await afterCycle(synced, d);
    expect(d.order).toEqual(['home', 'dup', 'auto']);
    await afterCycle({ ...synced, erpReached: false }, d);
    await afterCycle(null, d);
    await afterCycle({ failedSteps: [], skipped: 'site_mismatch' }, d);
    expect(d.autoApply).toHaveBeenCalledTimes(1);
  });

  it('Home is read again when something was answered automatically', async () => {
    const d = deps();
    d.autoApply.mockImplementationOnce(async () => 3);
    await afterCycle(synced, d);
    expect(d.invalidateHome).toHaveBeenCalledTimes(2);
  });

  it('a failure never blocks the cycle', async () => {
    const d = deps();
    d.autoApply.mockRejectedValueOnce(new Error('db'));
    await expect(afterCycle(synced, d)).resolves.toBeUndefined();
    expect(d.autoApply).toHaveBeenCalledTimes(1);
  });

  it('does not run when the duplicate check failed or could not run this cycle (warnings would be stale)', async () => {
    const d = deps();
    d.checkDuplicates.mockRejectedValueOnce(new Error('offline'));
    await afterCycle(synced, d);
    d.checkDuplicates.mockResolvedValueOnce(false);
    await afterCycle(synced, d);
    await afterCycle(synced, { ...d, checkDuplicates: undefined });
    expect(d.autoApply).not.toHaveBeenCalled();
  });

  it('runs inside the cycle: a second trigger meanwhile joins it, so no other step runs at the same time', async () => {
    const d = deps();
    let release: () => void = () => undefined;
    d.autoApply.mockImplementationOnce(() => new Promise<number>((res) => { release = () => res(0); }));
    const run = jest.fn(async () => synced);
    const r = createCycleRunner({ run, after: (s) => afterCycle(s, d) });
    const first = r.trigger();
    await new Promise((res) => setTimeout(res, 0));
    const second = r.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('cycle runner: the slow steps after a cycle (duplicate check, automatic answers)', () => {
  const synced = { failedSteps: [], drain: { ran: 0, stoppedBecause: 'empty' as const }, erpReached: true };

  it('the trigger (pull-to-refresh) resolves after the cycle and banners, before a slow background step ends', async () => {
    let release: () => void = () => undefined;
    const background = jest.fn(() => new Promise<void>((res) => { release = res; }));
    const after = jest.fn(async () => undefined);
    const r = createCycleRunner({ run: async () => synced, after, background });
    await r.trigger();
    expect(after).toHaveBeenCalledTimes(1);
    expect(background).toHaveBeenCalledTimes(1);
    expect(background).toHaveBeenCalledWith(synced);
    release();
    await r.idle();
  });

  it('a trigger while the background step runs starts neither a second cycle nor a second background step', async () => {
    let release: () => void = () => undefined;
    const background = jest.fn(() => new Promise<void>((res) => { release = res; }));
    const run = jest.fn(async () => synced);
    const r = createCycleRunner({ run, after: async () => undefined, background });
    await r.trigger();
    await r.trigger();
    expect(run).toHaveBeenCalledTimes(1);
    expect(background).toHaveBeenCalledTimes(1);
    release();
    await r.idle();
    await r.trigger();
    expect(run).toHaveBeenCalledTimes(2);
    expect(background).toHaveBeenCalledTimes(2);
    release();
    await r.idle();
  });

  it('a failing background step is swallowed and frees the runner', async () => {
    const background = jest.fn(async () => { throw new Error('db'); });
    const run = jest.fn(async () => synced);
    const r = createCycleRunner({ run, after: async () => undefined, background });
    await expect(r.trigger()).resolves.toBeUndefined();
    await expect(r.idle()).resolves.toBeUndefined();
    await r.trigger();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('afterCycleBackground: duplicate check then automatic answers, then the screens are refreshed', async () => {
    const order: string[] = [];
    const d = {
      onDone: jest.fn((n: number) => { order.push(`refresh ${n}`); }),
      checkDuplicates: jest.fn(async () => { order.push('dup'); return true; }),
      autoApply: jest.fn(async () => { order.push('auto'); return 2; }),
    };
    await afterCycleBackground(synced, d);
    expect(order).toEqual(['dup', 'auto', 'refresh 2']);
    order.length = 0;
    await afterCycleBackground({ ...synced, erpReached: false }, d);
    expect(order).toEqual([]);
    d.autoApply.mockRejectedValueOnce(new Error('db'));
    await expect(afterCycleBackground(synced, d)).resolves.toBeUndefined();
  });
});
