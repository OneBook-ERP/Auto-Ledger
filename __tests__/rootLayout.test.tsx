// The root layout starts crash reporting only when EXPO_PUBLIC_SENTRY_DSN is a non-empty string.
const mockInit = jest.fn();
jest.mock('../src/state/sentry', () => ({ initCrashReporting: (...a: unknown[]) => mockInit(...a) }));
jest.mock('../global.css', () => ({}), { virtual: true });
jest.mock('expo-router', () => ({ Stack: () => null }));
jest.mock('../src/state/AppProvider', () => ({ AppProvider: ({ children }: { children: unknown }) => children }));

const load = () => jest.isolateModules(() => void require('../app/_layout'));
const saved = process.env.EXPO_PUBLIC_SENTRY_DSN;

afterEach(() => {
  mockInit.mockClear();
  if (saved === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = saved;
});

it.each([[undefined], [''], ['  ']])('DSN %j (the default): crash reporting stays off', (dsn) => {
  if (dsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = dsn;
  load();
  expect(mockInit).not.toHaveBeenCalled();
});

it('a DSN set at build time starts it', () => {
  process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://k@o1.ingest.sentry.io/1';
  load();
  expect(mockInit).toHaveBeenCalledWith('https://k@o1.ingest.sentry.io/1');
});
