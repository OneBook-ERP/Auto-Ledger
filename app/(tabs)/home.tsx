import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { useHome } from '../../src/home/useHome';
import { MISMATCH_REASON } from '../../src/core/trust';
import { Banner, Button, Card, EmptyState, Figure, Screen } from '../../src/ui';

/** One line of text plus one action, for warnings that sit below the balance. */
function CompactNotice({ tone, message, a11yPrefix, actionLabel, onAction, testID }: { tone: 'warn' | 'info'; message: string; a11yPrefix?: string; actionLabel?: string; onAction?: () => void; testID?: string }) {
  const box = tone === 'warn' ? 'bg-warn-soft dark:bg-warn-soft-dark' : 'bg-accent-soft dark:bg-accent-soft-dark';
  const txt = tone === 'warn' ? 'text-warn dark:text-warn-dark' : 'text-accent dark:text-accent-dark';
  return (
    <View
      testID={testID}
      accessibilityRole={tone === 'warn' ? 'alert' : undefined}
      accessibilityLiveRegion="polite"
      className={`mb-4 flex-row items-center rounded-xl px-4 py-1 ${box}`}>
      <Text accessibilityLabel={a11yPrefix ? `${a11yPrefix}. ${message}` : undefined} className="flex-1 py-2 text-[15px] leading-5 text-ink dark:text-ink-dark">{message}</Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={actionLabel} className="ml-3 min-h-[48px] justify-center">
          <Text className={`text-base font-semibold ${txt}`}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default function Home() {
  const router = useRouter();
  const h = useHome();
  const m = h.model;

  if (h.status === 'loading') {
    return (
      <Screen title="Home">
        <Text accessibilityLiveRegion="polite" className="text-base text-muted dark:text-muted-dark">Loading your figures…</Text>
      </Screen>
    );
  }
  const expired = h.auth?.status === 401;
  const denied = h.auth !== null && !expired && h.auth.status === 403;
  const deniedText = `Your ERPNext user can't read ${h.auth?.deniedDoctype ?? 'this report'}. Ask your administrator for access.`;
  const signIn = () => router.push('/(auth)/login');
  if (h.status === 'error' || !m) {
    return (
      <Screen title="Home" refresh={{ refreshing: h.refreshing, onRefresh: () => void h.refresh() }}>
        <EmptyState
          title={expired ? 'Sign in again' : denied ? 'No access to these figures' : "Couldn't load your figures"}
          message={
            expired
              ? 'Your ERPNext sign-in has expired, so the figures cannot be loaded. Your entries stay on this phone.'
              : denied
                ? deniedText
                : 'AutoLedger could not reach ERPNext and has no saved figures yet. Check your connection and try again.'
          }
        />
        <View className="mt-4">
          {expired ? <Button label="Sign in again" onPress={signIn} /> : <Button label="Retry" onPress={h.retry} />}
        </View>
      </Screen>
    );
  }

  const incompleteReason = m.trust.reasons.find((r) => r !== MISMATCH_REASON);
  const drafts = m.drafts;
  const multi = m.bank.total !== null;
  const single = m.bank.accounts[0];
  return (
    <Screen title="Home" subtitle={h.company ?? undefined} refresh={{ refreshing: h.refreshing, onRefresh: () => void h.refresh() }}>
      {expired ? (
        <Banner tone="warn" title="Your ERPNext sign-in has expired" message="These figures could not be refreshed. Your entries stay on this phone." actionLabel="Sign in again" onAction={signIn} />
      ) : null}
      {denied ? <Banner tone="warn" message={deniedText} actionLabel="Retry" onAction={h.retry} /> : null}

      <Card>
        {multi ? (
          <>
            <Figure testID="bank-balance" label="Bank balance" value={m.bank.total?.text ?? '—'} size="xl" caption={m.asOfLabel ?? undefined} />
            <View className="mt-3 border-t border-line pt-1 dark:border-line-dark">
              {m.bank.accounts.map((a) => (
                <View key={a.glAccount} className="min-h-[48px] flex-row items-center justify-between">
                  <Text className="flex-1 text-base text-ink dark:text-ink-dark">{a.name}</Text>
                  <Text accessibilityLabel={`${a.name} ${a.text}`} style={{ fontVariant: ['tabular-nums'] }} className="ml-3 text-base font-medium text-ink dark:text-ink-dark">
                    {a.text}
                  </Text>
                </View>
              ))}
            </View>
          </>
        ) : (
          <Figure
            testID="bank-balance"
            label={single ? `Bank balance · ${single.name}` : 'Bank balance'}
            value={single?.text ?? '—'}
            size="xl"
            caption={m.asOfLabel ?? undefined}
          />
        )}
        {m.trustLine ? (
          <Text testID="trust-line" className={`mt-2 text-sm ${m.trust.mismatch ? 'text-warn dark:text-warn-dark' : 'text-ok dark:text-ok-dark'}`}>{m.trustLine}</Text>
        ) : null}
      </Card>

      {m.trust.incomplete && incompleteReason ? (
        <CompactNotice
          testID="banner-incomplete"
          tone="warn"
          a11yPrefix="These figures may be incomplete"
          message={`${incompleteReason}.`}
          actionLabel={m.unclassifiedCount > 0 ? 'Answer messages' : undefined}
          onAction={m.unclassifiedCount > 0 ? () => router.push('/(tabs)/inbox') : undefined}
        />
      ) : null}
      {m.trust.mismatch ? (
        <CompactNotice testID="banner-mismatch" tone="info" message="This may be because a draft is waiting or a message is unanswered." />
      ) : null}

      <View className="mb-4 flex-row items-stretch gap-3">
        <View className="flex-1 justify-between rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
          <Figure testID="to-receive" label={m.receivable.label} value={m.receivable.text} caption="After advances" />
        </View>
        <View className="flex-1 justify-between rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
          <Figure testID="to-pay" label={m.payable.label} value={m.payable.text} caption="After advances" />
        </View>
      </View>
      {m.asOfLabel ? <Text className="mb-3 text-sm text-muted dark:text-muted-dark">Figures shown {m.asOfLabel}.</Text> : null}
      {m.couldNotRefresh ? (
        <Text accessibilityLiveRegion="polite" className="mb-3 text-sm font-medium text-warn dark:text-warn-dark">Could not refresh. Pull down to try again.</Text>
      ) : null}

      <Card title="Waiting for your accountant">
        <View testID="drafts-row" accessible accessibilityLabel={`Waiting for your accountant. ${drafts.count} ${drafts.count === 1 ? 'draft' : 'drafts'}${drafts.summaryText ? `, ${drafts.summaryText}` : ''}`}>
          {drafts.count === 0 ? (
            <Text className="text-base text-muted dark:text-muted-dark">Nothing is waiting for your accountant.</Text>
          ) : (
            <>
              <Text className="text-base text-ink dark:text-ink-dark">
                {drafts.count === 1 ? '1 draft. It is not in the figures above yet.' : `${drafts.count} drafts. They are not in the figures above yet.`}
              </Text>
              {drafts.summaryText ? (
                <Text style={{ fontVariant: ['tabular-nums'] }} className="mt-1 text-xl font-semibold text-ink dark:text-ink-dark">{drafts.summaryText}</Text>
              ) : null}
              {drafts.footnote ? <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{drafts.footnote}</Text> : null}
            </>
          )}
        </View>
      </Card>

      <Text testID="last-synced" className="text-sm text-muted dark:text-muted-dark">{m.lastSyncedText}</Text>
    </Screen>
  );
}
