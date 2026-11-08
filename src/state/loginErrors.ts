// Plain-language mapping of sign-in failures. Messages never include the server's text, the password or keys.
import { ErpAuthError, ErpNetworkError, normalizeSiteUrl } from '../erp/client';
import { KeyGenerationNotPermitted, RotateDeclined, SessionCookieMissing, TwoFactorRequired } from '../erp/auth';

export type LoginProblem = {
  message: string;
  /** Show a "Sign in with an API key instead" action. */
  offerKeys: boolean;
  /** Switch straight to the paste-key form. */
  switchToKeys?: boolean;
  /** A hint rather than an error (the user chose to stop). */
  hint?: boolean;
};

export function describeLoginError(e: unknown): LoginProblem {
  if (e instanceof TwoFactorRequired) {
    return {
      message: 'This account uses two-factor sign-in, which password sign-in does not support. Sign in with an API key instead.',
      offerKeys: true,
    };
  }
  if (e instanceof KeyGenerationNotPermitted) {
    return {
      message:
        'This user cannot create an API key. Ask an administrator to generate one in ERPNext (open the user, then API Access, then Generate Keys), then paste the API key and secret here.',
      offerKeys: true,
      switchToKeys: true,
    };
  }
  if (e instanceof RotateDeclined) {
    return {
      message: 'Nothing was changed. To keep your existing API key working, sign in with a dedicated "AutoLedger" user instead.',
      offerKeys: false,
      hint: true,
    };
  }
  if (e instanceof SessionCookieMissing) {
    return {
      message: 'You signed in, but the session cookie was not kept. Try again, or sign in with an API key.',
      offerKeys: true,
    };
  }
  if (e instanceof ErpAuthError) {
    return { message: 'Wrong username or password, or this user has no permission to sign in.', offerKeys: false };
  }
  if (e instanceof ErpNetworkError) {
    return { message: 'Cannot reach the site. Check the address and your internet connection.', offerKeys: false };
  }
  return { message: 'Sign-in failed. Check the details and try again.', offerKeys: false };
}

export function checkSiteUrl(input: string, allowHttp: boolean): { ok: true; url: string } | { ok: false; message: string } {
  try {
    return { ok: true, url: normalizeSiteUrl(input, { allowHttp }) };
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (m === 'Use an https:// address.') return { ok: false, message: 'Use an https:// address. Plain http:// is only allowed in test builds.' };
    return { ok: false, message: m || 'That does not look like a valid site address.' };
  }
}
