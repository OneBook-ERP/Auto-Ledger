import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { gateTarget } from './gate';
import { useUiStore } from './store';
import Index from '../../app/index';

jest.mock('expo-router', () => {
  const { Text: T } = require('react-native');
  return { Redirect: ({ href }: { href: string }) => <T testID="redirect">{href}</T> };
});

describe('gateTarget', () => {
  it('not signed in -> login', () => expect(gateTarget({ signedIn: false, setupDone: false })).toBe('/(auth)/login'));
  it('not signed in ignores setupDone', () => expect(gateTarget({ signedIn: false, setupDone: true })).toBe('/(auth)/login'));
  it('signed in but setup not done -> wizard', () => expect(gateTarget({ signedIn: true, setupDone: false })).toBe('/(setup)/company'));
  it('signed in and setup done -> home', () => expect(gateTarget({ signedIn: true, setupDone: true })).toBe('/(tabs)/home'));
});

describe('app/index gate screen', () => {
  const reset = (p: Partial<ReturnType<typeof useUiStore.getState>>) => useUiStore.setState({ ...useUiStore.getInitialState(), ...p });
  it('shows nothing while booting', async () => {
    reset({ boot: 'loading' });
    await render(<Index />);
    expect(screen.queryByTestId('redirect')).toBeNull();
  });
  it.each([
    [{ session: null, setupDone: false }, '/(auth)/login'],
    [{ session: { siteUrl: 'https://a.b', user: 'u' }, setupDone: false }, '/(setup)/company'],
    [{ session: { siteUrl: 'https://a.b', user: 'u' }, setupDone: true }, '/(tabs)/home'],
  ])('redirects %j -> %s', async (state, href) => {
    reset({ boot: 'ready', ...state });
    await render(<Index />);
    expect(screen.getByTestId('redirect').props.children).toBe(href);
  });
});
void Text;
