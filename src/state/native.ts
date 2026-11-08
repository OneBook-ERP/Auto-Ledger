import type * as SmsIngest from '../../modules/sms-ingest/src';

export type SmsNative = typeof SmsIngest;

/**
 * The native SmsIngest bridge, resolved lazily: importing the module registers a native module, and nothing
 * native may run at import time. Tests mock '../../modules/sms-ingest/src'.
 */
export function getNative(): SmsNative {
  return require('../../modules/sms-ingest/src') as SmsNative;
}
