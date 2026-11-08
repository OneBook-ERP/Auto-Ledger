import { requireNativeModule } from 'expo-modules-core';

type SmsIngestNative = {
  requestPermissions(): Promise<boolean>;
  hasPermission(): boolean;
  peekQueue(): Promise<string>;
};

const native = requireNativeModule<SmsIngestNative>('SmsIngest');

export const requestPermissions = (): Promise<boolean> => native.requestPermissions();
export const hasPermission = (): boolean => native.hasPermission();
export const peekQueue = (): Promise<string> => native.peekQueue();
