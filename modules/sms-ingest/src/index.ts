import { requireNativeModule } from 'expo-modules-core';

/** An SMS held by the native queue (stored by the receiver). `kind` is the template kind or 'unrecognised'. */
export type QueuedSms = { id: string; sender: string; body: string; receivedAt: number; kind: string };

/** An SMS read from the inbox by backfill. */
export type RawSms = { sender: string; body: string; receivedAt: number };

export type PermissionState = { receive: boolean; read: boolean; notifications: boolean };
export type TemplatesInfo = { source: 'bundled' | 'override'; version: number | null };
export type EngineHealth = { usable: boolean; reason: string };

type SmsIngestNative = {
  setSenderPatterns(patterns: string[]): Promise<void>;
  getSenderPatterns(): Promise<string[]>;
  setTemplates(json: string): Promise<boolean>;
  resetTemplates(): Promise<void>;
  getTemplatesInfo(): Promise<TemplatesInfo>;
  engineHealth(): Promise<EngineHealth>;
  hasPermission(): Promise<PermissionState>;
  requestPermissions(): Promise<void>;
  peek(): Promise<QueuedSms[]>;
  ack(ids: string[]): Promise<void>;
  droppedCount(): Promise<number>;
  backfill(days: number, senderPatterns: string[]): Promise<RawSms[]>;
};

const native = requireNativeModule<SmsIngestNative>('SmsIngest');

/** Sender substrings (e.g. 'IDFCFB'), persisted natively. Until set, the receiver stores nothing. */
export const setSenderPatterns = (patterns: string[]): Promise<void> => native.setSenderPatterns(patterns);
export const getSenderPatterns = (): Promise<string[]> => native.getSenderPatterns();

/** Validates and stores a template set in preference to the bundled copy. Resolves false if invalid (nothing written). */
export const setTemplates = (json: string): Promise<boolean> => native.setTemplates(json);
/** Removes the stored template override; the bundled copy is used again. */
export const resetTemplates = (): Promise<void> => native.resetTemplates();
export const getTemplatesInfo = (): Promise<TemplatesInfo> => native.getTemplatesInfo();
/** usable=false means SMS are stored unparsed and no notifications are posted: warn the user. */
export const engineHealth = (): Promise<EngineHealth> => native.engineHealth();

export const hasPermission = (): Promise<PermissionState> => native.hasPermission();
/** Shows the system dialogs (RECEIVE_SMS, READ_SMS, POST_NOTIFICATIONS); resolves after the answer. */
export const requestPermissions = (): Promise<void> => native.requestPermissions();

/** Everything in the native queue, oldest first. Never removes anything: call `ack` once persisted. */
export const peek = (): Promise<QueuedSms[]> => native.peek();
/** Removes exactly these ids from the native queue. */
export const ack = (ids: string[]): Promise<void> => native.ack(ids);
/** How many queued SMS were dropped because the queue was full (500). */
export const droppedCount = (): Promise<number> => native.droppedCount();

/**
 * Inbox SMS from the given sender substrings in the last `days` days, newest first, at most 1000.
 * OTP and non-money SMS are dropped natively. [] without READ_SMS. Does not touch the queue.
 */
export const backfill = (days: number, senderPatterns: string[]): Promise<RawSms[]> =>
  native.backfill(days, senderPatterns);
