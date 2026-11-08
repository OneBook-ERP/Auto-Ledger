import { ErpAuthError, ErpNetworkError } from '../erp/client';
import { KeyGenerationNotPermitted, RotateDeclined, SessionCookieMissing, TwoFactorRequired } from '../erp/auth';
import { checkSiteUrl, describeLoginError } from './loginErrors';

describe('describeLoginError', () => {
  it('two-factor: explains and offers the API key path', () => {
    const r = describeLoginError(new TwoFactorRequired());
    expect(r.message).toBe('This account uses two-factor sign-in, which password sign-in does not support. Sign in with an API key instead.');
    expect(r.offerKeys).toBe(true);
  });
  it('key generation not permitted: shows the paste-key form', () => {
    const r = describeLoginError(new KeyGenerationNotPermitted());
    expect(r.message).toMatch(/API Access/);
    expect(r.offerKeys).toBe(true);
    expect(r.switchToKeys).toBe(true);
  });
  it('session cookie missing (checked before the generic auth error)', () => {
    const r = describeLoginError(new SessionCookieMissing(403));
    expect(r.message).toMatch(/session cookie was not kept/i);
    expect(r.offerKeys).toBe(true);
  });
  it('wrong credentials', () => {
    expect(describeLoginError(new ErpAuthError('x', 401)).message).toBe('Wrong username or password, or this user has no permission to sign in.');
  });
  it('network', () => {
    expect(describeLoginError(new ErpNetworkError('x')).message).toBe('Cannot reach the site. Check the address and your internet connection.');
  });
  it('declined rotation is a hint, not an error', () => {
    const r = describeLoginError(new RotateDeclined());
    expect(r.message).toMatch(/dedicated "AutoLedger" user/);
  });
  it('unknown errors never echo their text (could carry secrets)', () => {
    expect(describeLoginError(new Error('token k:SECRET')).message).not.toContain('SECRET');
  });
});

describe('checkSiteUrl', () => {
  it('accepts a bare host as https', () => {
    expect(checkSiteUrl('atom.onebook.app', false)).toEqual({ ok: true, url: 'https://atom.onebook.app' });
  });
  it('rejects http:// in release with a clear message', () => {
    const r = checkSiteUrl('http://atom.onebook.app', false);
    expect(r).toEqual({ ok: false, message: 'Use an https:// address. Plain http:// is only allowed in test builds.' });
  });
  it('allows http:// in dev builds', () => {
    expect(checkSiteUrl('http://10.0.2.2:8000', true)).toEqual({ ok: true, url: 'http://10.0.2.2:8000' });
  });
  it('asks for an address when empty', () => {
    expect(checkSiteUrl('  ', false)).toEqual({ ok: false, message: 'Enter your ERPNext site address.' });
  });
});
