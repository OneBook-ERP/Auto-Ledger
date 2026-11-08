import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { login, loginWithKeys, type Session } from '../../src/erp/auth';
import { useApp } from '../../src/state/AppProvider';
import { checkSiteUrl, describeLoginError, type LoginProblem } from '../../src/state/loginErrors';
import { useUiStore } from '../../src/state/store';
import { Banner, Button, Screen, TextField } from '../../src/ui';

export const ROTATE_TITLE = 'Replace your existing API key?';
export const ROTATE_MESSAGE =
  'This ERPNext user already has an API key. Continuing replaces the existing API secret with a new one and will break any other integration that uses it.\n\nWe recommend signing in with a dedicated "AutoLedger" user instead.';

/** Resolves true only when the user taps "Continue anyway". Any other way of closing the dialog is a refusal. */
function confirmRotate(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      ROTATE_TITLE,
      ROTATE_MESSAGE,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue anyway', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export const SWITCH_TITLE = 'Sign in to a different site?';
export const switchMessage = (n: number) =>
  `Signing in to a different ERPNext site removes this phone's saved accounts, settings and ${n} queued action${n === 1 ? '' : 's'} from the previous site.`;

function confirmSiteSwitch(queued: number): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      SWITCH_TITLE,
      switchMessage(queued),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export default function Login() {
  const app = useApp();
  const router = useRouter();
  const existing = useUiStore((s) => s.session);
  const [mode, setMode] = useState<'password' | 'keys'>('password');
  const [siteUrl, setSiteUrl] = useState(existing?.siteUrl ?? '');
  const [username, setUsername] = useState(existing?.user ?? '');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<LoginProblem | null>(null);
  const [siteError, setSiteError] = useState<string | undefined>();

  const submit = async () => {
    setProblem(null);
    const site = checkSiteUrl(siteUrl, __DEV__);
    if (!site.ok) {
      setSiteError(site.message);
      return;
    }
    setSiteError(undefined);
    if (mode === 'password' ? !username.trim() || !password : !apiKey.trim() || !apiSecret.trim()) {
      setProblem({ message: mode === 'password' ? 'Enter your username and password.' : 'Enter the API key and the API secret.', offerKeys: false });
      return;
    }
    setBusy(true);
    try {
      const sw = await app.previewSiteSwitch(site.url);
      if (sw.switching && !(await confirmSiteSwitch(sw.queuedActions))) return; // nothing changed, no sign-in
      let session: Session;
      if (mode === 'password') {
        session = await login({ siteUrl: site.url, username: username.trim(), password, confirmRotate, allowHttp: __DEV__ });
      } else {
        session = await loginWithKeys({ siteUrl: site.url, apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), allowHttp: __DEV__ });
      }
      await app.signIn(session);
      setApiSecret('');
      router.replace('/');
    } catch (e) {
      const p = describeLoginError(e);
      setProblem(p);
      if (p.switchToKeys) setMode('keys');
    } finally {
      setPassword(''); // the password is never kept once the call has returned
      setBusy(false);
    }
  };

  return (
    <Screen
      title={existing ? 'Sign in again' : 'Sign in to ERPNext'}
      subtitle={
        mode === 'password'
          ? 'Use the same site address and login as in your browser. Your password is used once to set up access and is never stored.'
          : 'Paste an API key and secret for your ERPNext user. In ERPNext, open the user, then API Access, then Generate Keys.'
      }
      footer={<Button label="Sign in" onPress={submit} loading={busy} />}>
      {problem ? (
        <Banner
          tone={problem.hint ? 'info' : 'error'}
          title={problem.hint ? undefined : 'Could not sign in'}
          message={problem.message}
          actionLabel={problem.offerKeys && mode === 'password' ? 'Sign in with an API key instead' : undefined}
          onAction={() => {
            setMode('keys');
            setProblem(null);
          }}
        />
      ) : null}
      <TextField
        label="Site address"
        value={siteUrl}
        onChangeText={setSiteUrl}
        placeholder="yourcompany.erpnext.com"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="URL"
        error={siteError}
      />
      {mode === 'password' ? (
        <>
          <TextField
            label="Username"
            value={username}
            onChangeText={setUsername}
            placeholder="name@company.com"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            keyboardType="email-address"
          />
          <TextField label="Password" value={password} onChangeText={setPassword} secret autoCapitalize="none" autoCorrect={false} autoComplete="current-password" />
        </>
      ) : (
        <>
          <TextField label="API key" value={apiKey} onChangeText={setApiKey} autoCapitalize="none" autoCorrect={false} autoComplete="off" />
          <TextField label="API secret" value={apiSecret} onChangeText={setApiSecret} secret autoCapitalize="none" autoCorrect={false} autoComplete="off" />
        </>
      )}
      <View className="items-start">
        <Button
          variant="quiet"
          label={mode === 'password' ? 'Use an API key instead' : 'Use username and password instead'}
          onPress={() => {
            setMode(mode === 'password' ? 'keys' : 'password');
            setProblem(null);
          }}
        />
      </View>
      <Text className="mt-4 text-sm leading-5 text-muted dark:text-muted-dark">
        AutoLedger creates draft entries only. Your accountant reviews and submits them in ERPNext.
      </Text>
    </Screen>
  );
}
