import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { hasPermission, peekQueue, requestPermissions } from '../modules/sms-ingest/src';

// SPIKE A screen (Task 2): replaced when real screens arrive.
export default function Index() {
  const [out, setOut] = useState('');
  const run = async (fn: () => Promise<string> | string) => {
    try {
      setOut(String(await fn()));
    } catch (e) {
      setOut(`error: ${String(e)}`);
    }
  };
  return (
    <View className="flex-1 bg-white px-4 pt-16">
      <Text className="mb-4 text-xl font-semibold">AutoLedger: SMS spike</Text>
      <Pressable
        className="mb-3 rounded bg-blue-600 p-3"
        onPress={() => run(async () => { await requestPermissions(); return `requested; RECEIVE_SMS granted now: ${hasPermission()}`; })}
      >
        <Text className="text-center text-white">Request SMS permissions</Text>
      </Pressable>
      <Pressable className="mb-3 rounded bg-blue-600 p-3" onPress={() => run(peekQueue)}>
        <Text className="text-center text-white">Show queue</Text>
      </Pressable>
      <ScrollView>
        <Text selectable>{out}</Text>
      </ScrollView>
    </View>
  );
}
