import { beforeBreadcrumb, initCrashReporting, resetCrashReportingForTests, sentryOptions, setCrashReportSite } from './sentry';

beforeEach(() => resetCrashReportingForTests());

describe('initCrashReporting', () => {
  it.each([[undefined], [''], ['   ']])('is OFF with DSN %j: the SDK is never loaded', (dsn) => {
    const load = jest.fn();
    expect(initCrashReporting(dsn, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('defaults to process.env.EXPO_PUBLIC_SENTRY_DSN (unset in tests: OFF)', () => {
    expect(process.env.EXPO_PUBLIC_SENTRY_DSN ?? '').toBe('');
    const load = jest.fn();
    expect(initCrashReporting(undefined, load)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('starts once with a DSN, with the privacy options', () => {
    const init = jest.fn();
    expect(initCrashReporting(' https://k@o1.ingest.sentry.io/1 ', () => ({ init }))).toBe(true);
    expect(initCrashReporting('https://k@o1.ingest.sentry.io/1', () => ({ init }))).toBe(true);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init.mock.calls[0][0]).toMatchObject({
      dsn: 'https://k@o1.ingest.sentry.io/1', sendDefaultPii: false, enableNative: false, enableNativeCrashHandling: false,
      attachScreenshot: false, attachViewHierarchy: false, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0, tracesSampleRate: 0,
      enableCaptureFailedRequests: false,
    });
    expect(init.mock.calls[0][0]).not.toHaveProperty('integrations');
  });

  it('never throws when the SDK fails to load or init', () => {
    expect(initCrashReporting('dsn', () => { throw new Error('no native module'); })).toBe(false);
    expect(initCrashReporting('dsn', () => ({ init: () => { throw new Error('bad dsn'); } }))).toBe(false);
  });
});

describe('options', () => {
  it('beforeBreadcrumb drops console, fetch and xhr breadcrumbs', () => {
    for (const category of ['console', 'fetch', 'xhr']) expect(beforeBreadcrumb({ category, message: 'x' })).toBeNull();
    expect(beforeBreadcrumb({ type: 'http', category: 'net' })).toBeNull();
    expect(beforeBreadcrumb({ category: 'navigation', message: '/inbox' })).toEqual({ category: 'navigation', message: '/inbox' });
    expect(beforeBreadcrumb(null)).toBeNull();
  });

  it('beforeSend is scrubEvent with the signed-in site host', () => {
    const { beforeSend } = sentryOptions('dsn') as { beforeSend: (e: unknown) => unknown };
    setCrashReportSite('http://erp.zp-internal:8000');
    expect(beforeSend({ message: 'cannot reach erp.zp-internal:8000 for IDFB6292M4509651 ₹ 1,200.00' })).toEqual({ message: 'cannot reach <site> for <ref> <amount>' });
    setCrashReportSite(null);
    expect(beforeSend({ message: 'erp.zp-internal' })).toEqual({ message: 'erp.zp-internal' });
    setCrashReportSite('not a url');
    expect(beforeSend({ message: 'ok' })).toEqual({ message: 'ok' });
  });
});
