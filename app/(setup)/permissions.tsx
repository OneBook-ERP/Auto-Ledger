import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import type { PermissionState } from '../../modules/sms-ingest/src';
import { useApp } from '../../src/state/AppProvider';
import { BACKFILL_DAYS_KEY, DEFAULT_BACKFILL_DAYS, ensureBackfill, syncSenderPatterns } from '../../src/ingest/pipeline';
import { BackfillChoice } from '../../src/state/BackfillChoice';
import { foundMessage } from '../../src/state/setup';
import { Banner, Button, Card, Screen, StepHeader } from '../../src/ui';

export const DISCLOSURE_TITLE = 'How AutoLedger uses your messages';
export const DISCLOSURE_POINTS = [
  'It reads only text messages from the bank senders you set up in the last step, and only from the period you choose below. You can change it later in Settings.',
  'Messages are read and understood on this phone. The raw text never leaves the phone.',
  'One-time passwords (OTPs) are ignored and never stored.',
  'Only the amount, date and a few details of each transaction are kept, to ask you what it was for. Transaction details go only to your own ERPNext site.',
];

export const RESTRICTED_HELP = 'Some phones show this. If the permission dialog does not appear, open App info > Permissions.';

export const BATTERY_TIP =
  'Turn off "Manage app if unused" for AutoLedger (App info), so Android does not remove the SMS permission after a quiet month. If alerts stop arriving, open App info > Battery usage and choose Allow background activity.';

export const SMS_DENIED_TITLE = 'SMS permission is off';
export const SMS_DENIED_MESSAGE = 'AutoLedger will NOT read your bank messages until SMS permission is granted. You can grant it later in Settings.';

const ROWS: { key: keyof PermissionState; label: string }[] = [
  { key: 'receive', label: 'Receive SMS' },
  { key: 'read', label: 'Read SMS' },
  { key: 'notifications', label: 'Notifications' },
];

export default function PermissionsStep() {
  const { native, repo, completeSetup } = useApp();
  const router = useRouter();
  const [disclosed, setDisclosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [perm, setPerm] = useState<PermissionState | null>(null);
  const [error, setError] = useState(false);
  const [days, setDays] = useState<number>(DEFAULT_BACKFILL_DAYS);
  const [found, setFound] = useState<string | null>(null);

  const chooseDays = (d: number) => {
    setDays(d);
    void repo.setSetting(BACKFILL_DAYS_KEY, String(d));
  };

  const check = async () => setPerm(await native.hasPermission());

  // Only after the user has read the disclosure and chosen Continue.
  const request = async () => {
    setDisclosed(true);
    setBusy(true);
    setError(false);
    try {
      await native.requestPermissions();
      await check();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (found === null && perm && !(perm.receive && perm.read)) {
      const go = await new Promise<boolean>((resolve) =>
        Alert.alert(
          SMS_DENIED_TITLE,
          SMS_DENIED_MESSAGE,
          [
            { text: 'Go back', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Finish anyway', onPress: () => resolve(true) },
          ],
          { cancelable: true, onDismiss: () => resolve(false) },
        ),
      );
      if (!go) return;
    }
    setFinishing(true);
    setError(false);
    try {
      if (found === null) {
        await syncSenderPatterns({ repo, native });
        await repo.setSetting(BACKFILL_DAYS_KEY, String(days));
        try {
          const r = await ensureBackfill({ repo, native, now: Date.now }, { fullWindow: true });
          if (!r.backfillSkipped && r.inserted + r.enriched + r.duplicates > 0) {
            setFound(foundMessage(r));
            return; // show the result; the next press finishes
          }
        } catch {
          // the first cycle after setup reads the messages again
        }
      }
      await completeSetup(); // sets setupDone and runs one foreground cycle
      router.replace('/(tabs)/home');
    } catch {
      setError(true);
    } finally {
      setFinishing(false);
    }
  };

  const allGranted = !!perm && perm.receive && perm.read && perm.notifications;

  if (!disclosed) {
    return (
      <Screen
        top={<StepHeader step={4} total={4} label="Permissions" />}
        title={DISCLOSURE_TITLE}
        subtitle="Before Android asks for permission, here is exactly what AutoLedger does with it."
        footer={<Button label="Continue" onPress={request} accessibilityHint="Android will ask for SMS and notification permission" />}>
        <Card>
          {DISCLOSURE_POINTS.map((p) => (
            <View key={p} className="mb-3 flex-row">
              <Text className="mr-2 text-base text-accent dark:text-accent-dark">{'•'}</Text>
              <Text className="flex-1 text-base leading-6 text-ink dark:text-ink-dark">{p}</Text>
            </View>
          ))}
        </Card>
        <Card>
          <BackfillChoice days={days} onChange={chooseDays} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      top={<StepHeader step={4} total={4} label="Permissions" />}
      title="Allow SMS and notifications"
      subtitle="AutoLedger needs these to see new bank messages and tell you about them."
      footer={<Button label={found === null ? 'Finish setup' : 'Continue'} onPress={finish} loading={finishing} disabled={busy} />}>
      {error ? <Banner tone="error" message="Something went wrong. Try again." /> : null}
      {found !== null ? <Banner tone="ok" message={found} /> : null}
      {perm
        ? ROWS.map((r) => (
            <View key={r.key} className="mb-2 min-h-[48px] flex-row items-center justify-between rounded-xl border border-line bg-surface px-4 dark:border-line-dark dark:bg-surface-dark">
              <Text className="text-base text-ink dark:text-ink-dark">{r.label}</Text>
              <Text className={`text-base font-semibold ${perm[r.key] ? 'text-ok dark:text-ok-dark' : 'text-danger dark:text-danger-dark'}`}>{perm[r.key] ? 'Allowed' : 'Not allowed'}</Text>
            </View>
          ))
        : null}
      {perm && !allGranted ? (
        <View className="mt-2">
          <Banner tone="warn" title="Some permissions are missing" message={RESTRICTED_HELP} />
          <View className="flex-row gap-3">
            <View className="flex-1"><Button variant="secondary" label="Ask again" onPress={request} loading={busy} /></View>
            <View className="flex-1"><Button variant="secondary" label="Check again" onPress={check} /></View>
          </View>
        </View>
      ) : null}
      {allGranted ? <Banner tone="ok" message="All set. AutoLedger can now read your bank messages." /> : null}
      <Card title="Keep alerts reliable">
        <Text className="text-base leading-6 text-muted dark:text-muted-dark">{BATTERY_TIP}</Text>
      </Card>
    </Screen>
  );
}
