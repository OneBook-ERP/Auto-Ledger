import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import idfc from '../templates/idfc.json';
import { Redirect } from 'expo-router';
import { getNative } from '../src/state/native';
import { ListRow } from '../src/ui';

// DEBUG "Receiver test" screen (Task 9). Shows raw SMS bodies, so it exists only in development builds:
// reachable from Settings when __DEV__ is true, and redirected away in release builds (deep links included).
export default function DebugReceiver() {
  if (!__DEV__) return <Redirect href="/" />;
  return <DebugReceiverScreen />;
}

function DebugReceiverScreen() {
  const sms = getNative();
  const [extra, setExtra] = useState('');
  const [out, setOut] = useState('');
  const run = async (fn: () => Promise<string>) => {
    try {
      setOut(await fn());
    } catch (e) {
      setOut(`error: ${String(e)}`);
    }
  };
  const patterns = () => ['IDFCFB', ...(extra.trim() ? [extra.trim()] : [])];

  const actions: { title: string; subtitle?: string; fn: () => Promise<string> }[] = [
    {
      title: 'Request permissions',
      fn: async () => {
        await sms.requestPermissions();
        return JSON.stringify(await sms.hasPermission());
      },
    },
    {
      title: 'Set sender patterns',
      subtitle: 'IDFCFB plus the optional extra pattern',
      fn: async () => {
        await sms.setSenderPatterns(patterns());
        return `patterns: ${JSON.stringify(await sms.getSenderPatterns())}`;
      },
    },
    {
      title: 'Use test templates',
      subtitle: 'Bundled IDFC templates, also applied to the extra pattern',
      fn: async () => {
        const p = extra.trim();
        if (!p) return 'enter an extra pattern first';
        const banks = [...idfc.banks, { ...idfc.banks[0], id: 'test', senderPattern: p }];
        const ok = await sms.setTemplates(JSON.stringify({ ...idfc, banks }));
        return `setTemplates: ${ok}; ${JSON.stringify(await sms.getTemplatesInfo())}`;
      },
    },
    {
      title: 'Reset templates',
      fn: async () => {
        await sms.resetTemplates();
        return JSON.stringify(await sms.getTemplatesInfo());
      },
    },
    {
      title: 'Engine health and templates',
      fn: async () =>
        JSON.stringify({
          health: await sms.engineHealth(),
          templates: await sms.getTemplatesInfo(),
          patterns: await sms.getSenderPatterns(),
          permissions: await sms.hasPermission(),
          dropped: await sms.droppedCount(),
        }, null, 1),
    },
    {
      title: 'Peek queue',
      fn: async () => {
        const q = await sms.peek();
        if (q.length === 0) return 'queue empty';
        return q
          .map((m) => `${m.id}  ${m.sender}  ${m.kind}  ${new Date(m.receivedAt).toISOString()}\n${m.body}`)
          .join('\n\n');
      },
    },
    {
      title: 'Ack all',
      fn: async () => {
        const q = await sms.peek();
        await sms.ack(q.map((m) => m.id));
        return `acked ${q.length}`;
      },
    },
    {
      title: 'Backfill 7 days',
      fn: async () => `backfill: ${(await sms.backfill(7, patterns())).messages.length} messages`,
    },
  ];

  return (
    <View className="flex-1 bg-white pt-12">
      <Text className="px-4 pb-2 text-xl font-semibold">Receiver test (debug)</Text>
      <TextInput
        className="mx-4 mb-2 rounded border border-neutral-300 px-3 py-2"
        placeholder="Extra sender pattern (optional, for testing)"
        autoCapitalize="none"
        autoCorrect={false}
        value={extra}
        onChangeText={setExtra}
      />
      {actions.map((a) => (
        <ListRow key={a.title} title={a.title} subtitle={a.subtitle} onPress={() => run(a.fn)} />
      ))}
      <ScrollView className="flex-1 px-4 pt-2">
        <Text selectable>{out}</Text>
      </ScrollView>
    </View>
  );
}
