import { useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { useHome } from '../../src/home/useHome';
import { MISMATCH_REASON } from '../../src/core/trust';
import { Banner, Button, Card, EmptyState, Figure, Screen } from '../../src/ui';

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
  if (h.status === 'error' || !m) {
    return (
      <Screen title="Home" refresh={{ refreshing: h.refreshing, onRefresh: () => void h.refresh() }}>
        <EmptyState
          title={h.authError ? 'Sign in again' : "Couldn't load your figures"}
          message={h.authError ? 'ERPNext did not accept your saved sign-in, so the figures cannot be refreshed. Sign in again from the banner above.' : 'AutoLedger could not reach ERPNext and has no saved figures yet. Check your connection and try again.'}
        />
        <View className="mt-4">
          <Button label="Retry" onPress={h.retry} />
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
      {m.trust.incomplete && incompleteReason ? (
        <Banner
          testID="banner-incomplete"
          tone="warn"
          title="These figures may be incomplete"
          message={`${incompleteReason}.`}
          actionLabel={m.unclassifiedCount > 0 ? 'Answer messages' : undefined}
          onAction={m.unclassifiedCount > 0 ? () => router.push('/(tabs)/inbox') : undefined}
        />
      ) : null}
      {m.trust.mismatch ? (
        <Banner
          testID="banner-mismatch"
          tone="info"
          title="Balance differs from your latest bank message"
          message="This may be because a draft is waiting or a message is unanswered."
        />
      ) : null}
      {h.authError && m.couldNotRefresh ? (
        <Banner tone="warn" message="Your ERPNext sign-in has expired, so these figures could not be refreshed. Sign in again to update them." />
      ) : null}

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
      </Card>

      <View className="mb-4 flex-row gap-3">
        <View className="flex-1 rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
          <Figure testID="to-receive" label="To receive" value={m.receivableText} caption="After advances" />
        </View>
        <View className="flex-1 rounded-2xl border border-line bg-surface p-4 dark:border-line-dark dark:bg-surface-dark">
          <Figure testID="to-pay" label="To pay" value={m.payableText} caption="After advances" />
        </View>
      </View>
      {m.asOfLabel ? <Text className="mb-3 text-sm text-muted dark:text-muted-dark">Figures shown {m.asOfLabel}.</Text> : null}
      {m.couldNotRefresh ? (
        <Text accessibilityLiveRegion="polite" className="mb-3 text-sm font-medium text-warn dark:text-warn-dark">Could not refresh. Pull down to try again.</Text>
      ) : null}

      <Card title="Waiting for your accountant">
        <View testID="drafts-row" accessible accessibilityLabel={`Waiting for your accountant. ${drafts.count} ${drafts.count === 1 ? 'draft' : 'drafts'}${drafts.count > 0 ? `, ${drafts.totalText}` : ''}`}>
          {drafts.count === 0 ? (
            <Text className="text-base text-muted dark:text-muted-dark">Nothing is waiting for your accountant.</Text>
          ) : (
            <>
              <Text className="text-base text-ink dark:text-ink-dark">
                {drafts.count === 1 ? '1 draft. It is not in the figures above yet.' : `${drafts.count} drafts. They are not in the figures above yet.`}
              </Text>
              <Text style={{ fontVariant: ['tabular-nums'] }} className="mt-1 text-xl font-semibold text-ink dark:text-ink-dark">{drafts.totalText}</Text>
              {drafts.footnote ? <Text className="mt-0.5 text-sm text-muted dark:text-muted-dark">{drafts.footnote}</Text> : null}
            </>
          )}
        </View>
      </Card>

      <Text testID="last-synced" className="text-sm text-muted dark:text-muted-dark">{m.lastSyncedText}</Text>
    </Screen>
  );
}
