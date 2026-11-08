import { createCycleRunner } from './cycle';

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
