import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import Constants from 'expo-constants';
import { Alert, Pressable, Text, View } from 'react-native';
import type { PermissionState } from '../../modules/sms-ingest/src';
import type { AccountMapping } from '../../src/core/types';
import { BACKFILL_DAYS_KEY, DEFAULT_BACKFILL_DAYS, ensureBackfill, getBackfillDays, UNRECOGNISED_COUNT_KEY } from '../../src/ingest/pipeline';
import { BackfillChoice } from '../../src/state/BackfillChoice';
import { foundMessage } from '../../src/state/setup';
import { useApp } from '../../src/state/AppProvider';
import { useUiStore } from '../../src/state/store';
import { Button, Card, Screen } from '../../src/ui';

const describeMapping = (m: AccountMapping) =>
  `${m.kind === 'card' ? 'Card' : 'Bank'}, ending ${m.last4.join(', ')}, from ${m.senderIds.join(', ')}`;

export default function Settings() {
  const { repo, native, signOut } = useApp();
  const router = useRouter();
  const session = useUiStore((s) => s.session);
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [unread, setUnread] = useState(0);
  const [engine, setEngine] = useState<string>('Checking...');
  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [asking, setAsking] = useState(false);
  const [days, setDays] = useState<number>(DEFAULT_BACKFILL_DAYS);
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const [m, u] = await Promise.all([repo.listMappings(), repo.getSetting(UNRECOGNISED_COUNT_KEY)]);
      if (!live) return;
      setMappings(m);
      setUnread(Number(u) || 0);
      const d = await getBackfillDays(repo);
      if (live) setDays(d);
      try {
        const p = await native.hasPermission();
        if (live) setPerm(p);
      } catch {
        // status stays unknown
      }
      try {
        const h = await native.engineHealth();
        if (live) setEngine(h.usable ? 'Working' : 'Unavailable. Update the app.');
      } catch {
        if (live) setEngine('Unavailable. Update the app.');
      }
    })();
    return () => {
      live = false;
    };
  }, [repo, native]);

  const grantSms = async () => {
    setAsking(true);
    try {
      await native.requestPermissions();
      setPerm(await native.hasPermission());
    } finally {
      setAsking(false);
    }
  };

  const changeDays = async (d: number) => {
    if (d === days || scanning) return;
    setDays(d);
    setFound(null);
    setScanning(true);
    try {
      await repo.setSetting(BACKFILL_DAYS_KEY, String(d));
      const r = await ensureBackfill({ repo, native, now: Date.now }, { fullWindow: true });
      if (!r.backfillSkipped) setFound(foundMessage(r));
    } catch {
      setFound('Could not read your messages. Try again.');
    } finally {
      setScanning(false);
    }
  };

  const smsOn = !!perm && perm.receive && perm.read;

  const confirmSignOut = () =>
    Alert.alert('Sign out?', 'AutoLedger forgets your login. Entries and settings already on this phone are kept.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await signOut();
          router.replace('/');
        },
      },
    ]);

  const version = Constants.expoConfig?.version ?? '1.0.0';
  const explainUnread = () =>
    Alert.alert('Messages that could not be read', 'These bank messages were not in a format AutoLedger knows, so they were skipped. Your balances are not affected. If it keeps growing, update the app.');

  return (
    <Screen title="Settings">
      <Card title="Connection">
        <Text className="text-base text-ink dark:text-ink-dark">{session?.siteUrl ?? 'Not signed in'}</Text>
        <Text className="mt-1 text-base text-muted dark:text-muted-dark">{session?.user ?? ''}</Text>
      </Card>

      <Card title="Accounts">
        {mappings.length === 0 ? <Text className="text-base text-muted dark:text-muted-dark">No accounts set up yet.</Text> : null}
        {mappings.map((m) => (
          <View key={m.bankAccount} className="min-h-[56px] flex-row items-center border-b border-line py-2 dark:border-line-dark">
            <View className="flex-1">
              <Text className="text-base font-medium text-ink dark:text-ink-dark">{m.bankAccount}</Text>
              <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{describeMapping(m)}</Text>
            </View>
            <Pressable
              onPress={() => router.push({ pathname: '/(setup)/accounts', params: { account: m.bankAccount } })}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${m.bankAccount}`}
              className="ml-3 min-h-[48px] min-w-[48px] items-center justify-center">
              <Text className="text-base font-semibold text-accent dark:text-accent-dark">Edit</Text>
            </Pressable>
          </View>
        ))}
        <View className="mt-3">
          <Button variant="secondary" label="Run setup again" onPress={() => router.push('/(setup)/company')} />
        </View>
      </Card>

      <Card title="SMS reading">
        <Text className="text-base text-ink dark:text-ink-dark">SMS reading: {engine}</Text>
        <Text className="mt-2 text-base text-ink dark:text-ink-dark">
          {perm === null ? 'Checking...' : smsOn ? 'Allowed. Bank messages are being read.' : 'Not allowed. Bank messages are NOT being read.'}
        </Text>
        {!smsOn && perm !== null ? (
          <View className="mt-3">
            <Button label="Grant SMS permission" onPress={grantSms} loading={asking} />
            <Text className="mt-2 text-sm text-muted dark:text-muted-dark">If no dialog appears, open App info &gt; Permissions.</Text>
          </View>
        ) : null}
        <View className="mt-4">
          <BackfillChoice days={days} onChange={changeDays} disabled={scanning} />
          {scanning ? <Text className="mt-2 text-sm text-muted dark:text-muted-dark">Reading your messages...</Text> : null}
          {found ? <Text className="mt-2 text-base text-ink dark:text-ink-dark">{found}</Text> : null}
        </View>
        {unread > 0 ? (
          <View className="mt-3 flex-row items-center">
            <Text className="flex-1 text-base text-ink dark:text-ink-dark">Messages that could not be read: {unread}</Text>
            <Pressable onPress={explainUnread} accessibilityRole="button" accessibilityLabel="What does this mean?" className="ml-3 min-h-[48px] justify-center">
              <Text className="text-base font-semibold text-accent dark:text-accent-dark">What does this mean?</Text>
            </Pressable>
          </View>
        ) : null}
      </Card>

      <Card title="About">
        <Text className="text-base text-ink dark:text-ink-dark">AutoLedger version {version}</Text>
      </Card>

      <View className="gap-3">
        {__DEV__ ? <Button variant="quiet" label="Receiver test (debug)" onPress={() => router.push('/debug-receiver')} /> : null}
        <Button variant="danger" label="Sign out" onPress={confirmSignOut} />
      </View>
    </Screen>
  );
}
