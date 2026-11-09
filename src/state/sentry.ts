// Crash reporting (plan Task 20 Step 2). OFF by default: Sentry is initialised only when the build sets
// EXPO_PUBLIC_SENTRY_DSN to a non-empty string; with the default (empty / unset) nothing is loaded, nothing
// is sent, and @sentry/react-native is never even evaluated.
//
// When ON, every event leaves the phone only through scrubEvent (amounts, UTRs, account numbers, SMS text,
// emails, credentials and the ERPNext site are removed). JS only: the native SDK (and so native/NDK crash
// capture, which would bypass the JS scrubber) is disabled, as are session replay, screenshots, the view
// hierarchy, tracing/profiling (and trace-header propagation), failed-request capture and console/fetch/xhr breadcrumbs.
import { scrubEvent } from './scrub';

/** The part of @sentry/react-native this module uses. */
export type SentryLike = { init(options: Record<string, unknown>): void };
type Breadcrumb = { category?: string; type?: string } & Record<string, unknown>;

const DROPPED = new Set(['console', 'fetch', 'xhr', 'http']);
let siteHosts: string[] = [];
let started = false;

/** Tells the scrubber which ERPNext host to hide (call on boot and sign-in; null on sign-out). */
export function setCrashReportSite(siteUrl: string | null): void {
  if (!siteUrl) {
    siteHosts = [];
    return;
  }
  try {
    // host keeps a non-default port (erp.example:8000), hostname does not; both are hidden, any letter case
    // (the scrubber matches case-insensitively, longest first).
    const u = new URL(siteUrl);
    siteHosts = [...new Set([u.host, u.hostname].map((h) => h.toLowerCase()).filter(Boolean))];
  } catch {
    siteHosts = [];
  }
}

export function beforeBreadcrumb<B extends Breadcrumb>(b: B | null): B | null {
  if (!b) return null;
  if ((typeof b.category === 'string' && DROPPED.has(b.category)) || b.type === 'http') return null;
  return b;
}

/** The exact options passed to Sentry.init. */
export function sentryOptions(dsn: string): Record<string, unknown> {
  return {
    dsn,
    sendDefaultPii: false,
    enableNative: false,
    enableNativeCrashHandling: false,
    enableNdk: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    enableCaptureFailedRequests: false,
    enableAutoPerformanceTracing: false,
    enableAutoSessionTracking: false,
    // Tracing stays off: no tracesSampleRate and no tracing integration, so no transactions are created;
    // no trace headers are attached to any outgoing request (in particular never to the ERPNext site).
    tracePropagationTargets: [],
    profilesSampleRate: 0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    maxBreadcrumbs: 30,
    beforeBreadcrumb,
    beforeSend: (event: unknown) => scrubEvent(event, { hosts: siteHosts }),
  };
}

/**
 * Starts Sentry when `dsn` is a non-empty string; otherwise does nothing (the default). Returns whether it
 * started. Never throws: crash reporting must never stop the app from starting.
 */
export function initCrashReporting(
  dsn: string | undefined = process.env.EXPO_PUBLIC_SENTRY_DSN,
  load: () => SentryLike = () => require('@sentry/react-native') as SentryLike,
): boolean {
  if (started) return true;
  if (typeof dsn !== 'string' || dsn.trim() === '') return false;
  try {
    load().init(sentryOptions(dsn.trim()));
    started = true;
    return true;
  } catch {
    return false;
  }
}

/** Test-only. */
export function resetCrashReportingForTests(): void {
  started = false;
  siteHosts = [];
}
