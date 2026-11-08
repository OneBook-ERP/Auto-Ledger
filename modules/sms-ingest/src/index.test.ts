import type { QueuedSms } from './index';

const mockQueue: QueuedSms[] = [];
const mockNative = {
  setSenderPatterns: jest.fn(async (_p: string[]) => undefined),
  getSenderPatterns: jest.fn(async () => ['IDFCFB']),
  setTemplates: jest.fn(async (json: string) => json.startsWith('{')),
  resetTemplates: jest.fn(async () => undefined),
  getTemplatesInfo: jest.fn(async () => ({ source: 'bundled', version: 1 })),
  engineHealth: jest.fn(async () => ({ usable: true, reason: 'ok' })),
  hasPermission: jest.fn(async () => ({ receive: true, read: false, notifications: true })),
  requestPermissions: jest.fn(async () => undefined),
  peek: jest.fn(async () => mockQueue.map((q) => ({ ...q }))),
  ack: jest.fn(async (ids: string[]) => {
    for (let i = mockQueue.length - 1; i >= 0; i--) if (ids.includes(mockQueue[i].id)) mockQueue.splice(i, 1);
  }),
  droppedCount: jest.fn(async () => 3),
  backfill: jest.fn(async (_d: number, _p: string[]) => [{ sender: 'JM-IDFCFB-S', body: 'x', receivedAt: 1 }]),
};

jest.mock('expo-modules-core', () => ({ requireNativeModule: jest.fn(() => mockNative) }));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sms = require('./index') as typeof import('./index');
const loadedWith = (jest.requireMock('expo-modules-core').requireNativeModule as jest.Mock).mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.clearAllMocks();
  mockQueue.length = 0;
});

it('loads the SmsIngest native module', () => {
  expect(loadedWith).toEqual(['SmsIngest']);
});

it('passes sender patterns, templates and ids through unchanged', async () => {
  await sms.setSenderPatterns(['IDFCFB', 'TESTPAT']);
  expect(mockNative.setSenderPatterns).toHaveBeenCalledWith(['IDFCFB', 'TESTPAT']);
  expect(await sms.getSenderPatterns()).toEqual(['IDFCFB']);
  expect(await sms.setTemplates('{"version":2}')).toBe(true);
  expect(mockNative.setTemplates).toHaveBeenCalledWith('{"version":2}');
  expect(await sms.setTemplates('junk')).toBe(false);
  await sms.resetTemplates();
  expect(mockNative.resetTemplates).toHaveBeenCalledTimes(1);
  expect(await sms.getTemplatesInfo()).toEqual({ source: 'bundled', version: 1 });
  expect(await sms.engineHealth()).toEqual({ usable: true, reason: 'ok' });
  expect(await sms.hasPermission()).toEqual({ receive: true, read: false, notifications: true });
  await sms.requestPermissions();
  expect(mockNative.requestPermissions).toHaveBeenCalledTimes(1);
  expect(await sms.droppedCount()).toBe(3);
});

it('peek never removes; ack removes exactly the given ids', async () => {
  mockQueue.push(
    { id: 'a', sender: 'JM-IDFCFB-S', body: 'one', receivedAt: 1, kind: 'ca_credit' },
    { id: 'b', sender: 'JM-IDFCFB-S', body: 'two', receivedAt: 2, kind: 'unrecognised' },
  );
  const first = await sms.peek();
  expect(first.map((q) => q.id)).toEqual(['a', 'b']);
  expect(await sms.peek()).toEqual(first);
  await sms.ack(['a']);
  expect(mockNative.ack).toHaveBeenCalledWith(['a']);
  expect((await sms.peek()).map((q) => q.id)).toEqual(['b']);
  await sms.ack(first.map((q) => q.id));
  expect(await sms.peek()).toEqual([]);
});

it('backfill passes days and sender patterns through', async () => {
  const out = await sms.backfill(7, ['IDFCFB']);
  expect(mockNative.backfill).toHaveBeenCalledWith(7, ['IDFCFB']);
  expect(out).toEqual([{ sender: 'JM-IDFCFB-S', body: 'x', receivedAt: 1 }]);
});
