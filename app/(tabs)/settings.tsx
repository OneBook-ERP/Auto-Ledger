import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { AccountMapping } from '../../src/core/types';
import { UNRECOGNISED_COUNT_KEY } from '../../src/ingest/pipeline';
import { useApp } from '../../src/state/AppProvider';
import { useUiStore } from '../../src/state/store';
import { Button, Card, ListRow, Screen } from '../../src/ui';

const describeMapping = (m: AccountMapping) =>
  `${m.kind === 'card' ? 'Card' : 'Bank'}, ending ${m.last4.join(', ')}, from ${m.senderIds.join(', ')}`;

export default function Settings() {
  const { repo, native, signOut } = useApp();
  const router = useRouter();
  const session = useUiStore((s) => s.session);
  const [mappings, setMappings] = useState<AccountMapping[]>([]);
  const [unread, setUnread] = useState(0);
  const [engine, setEngine] = useState<string>('Checking...');

  useEffect(() => {
    let live = true;
    (async () => {
      const [m, u] = await Promise.all([repo.listMappings(), repo.getSetting(UNRECOGNISED_COUNT_KEY)]);
      if (!live) return;
      setMappings(m);
      setUnread(Number(u) || 0);
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

  return (
    <Screen title="Settings">
      <Card title="Connected to">
        <Text className="text-base text-ink dark:text-ink-dark">{session?.siteUrl ?? 'Not signed in'}</Text>
        <Text className="mt-1 text-base text-muted dark:text-muted-dark">{session?.user ?? ''}</Text>
      </Card>

      <Card title="Accounts">
        {mappings.length === 0 ? <Text className="text-base text-muted dark:text-muted-dark">No accounts set up yet.</Text> : null}
        {mappings.map((m) => (
          <ListRow key={m.bankAccount} title={m.bankAccount} subtitle={describeMapping(m)} />
        ))}
      </Card>

      <Card title="Reading messages">
        <Text className="text-base text-ink dark:text-ink-dark">Messages that could not be read: {unread}</Text>
        <Text className="mt-2 text-base text-ink dark:text-ink-dark">SMS reading: {engine}</Text>
      </Card>

      <View className="gap-3">
        <Button variant="secondary" label="Run setup again" onPress={() => router.push('/(setup)/company')} />
        {__DEV__ ? <Button variant="quiet" label="Receiver test (debug)" onPress={() => router.push('/debug-receiver')} /> : null}
        <Button variant="danger" label="Sign out" onPress={confirmSignOut} />
      </View>
    </Screen>
  );
}
