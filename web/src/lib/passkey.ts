import { ApiError } from './api';
import { de } from './i18n/de';

/** Clear German message for a failed passkey ceremony (WebAuthn error or API error). */
export function passkeyErrorMessage(err: unknown, ceremony: 'login' | 'setup' | 'add'): string {
  if (err instanceof ApiError) {
    if (isOriginError(err)) return de.errors.wrongOrigin;
    if (err.status === 429) return de.errors.rateLimited;
    if (ceremony === 'add') {
      if (err.status === 401) return de.errors.confirmFailed;
      if (err.status === 409) return de.errors.duplicate;
      if (err.status === 400) return de.errors.challenge;
      return `${de.errors.unexpected}: ${err.message}`;
    }
    if (err.status === 403 && ceremony === 'setup') return de.errors.setupDenied;
    if (err.status === 409 && ceremony === 'setup') return de.errors.duplicate;
    if (err.status === 401 && ceremony === 'login') return de.errors.loginFailed;
    if (err.status === 400) return ceremony === 'login' ? de.errors.loginFailed : de.errors.challenge;
    return `${de.errors.unexpected}: ${err.message}`;
  }
  if (err instanceof Error) {
    // @simplewebauthn/browser keeps the DOMException name of the browser error.
    if (err.name === 'NotAllowedError' || err.name === 'AbortError') return de.errors.cancelled;
    if (err.name === 'InvalidStateError') return de.errors.duplicate;
    if (err instanceof TypeError) return de.errors.network;
    return `${de.errors.unexpected}: ${err.message}`;
  }
  return de.errors.unexpected;
}

/** The server refused the request because the page is not open under PUBLIC_URL's origin. */
export const isOriginError = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.status === 403 &&
  typeof err.body === 'object' &&
  err.body !== null &&
  (err.body as { code?: unknown }).code === 'ORIGIN';

/** True when the page runs under another origin than the app's configured one. */
export const isWrongOrigin = (publicOrigin: string | undefined): boolean =>
  publicOrigin !== undefined && publicOrigin !== location.origin;

/** Expected outcome of an aborted or dismissed ceremony (e.g. the autofill request cancelled by the button). */
export const isCancellation = (err: unknown): boolean =>
  err instanceof Error && (err.name === 'AbortError' || err.name === 'NotAllowedError');

/** Default device name for a new passkey, guessed from the user agent. */
export function defaultDeviceName(ua: string): string {
  if (/iPhone/.test(ua)) return de.devices.iphone;
  // iPadOS reports itself as a Mac; touch support tells them apart.
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1)) {
    return de.devices.ipad;
  }
  if (/Android/.test(ua)) return de.devices.android;
  if (/Macintosh|Mac OS X/.test(ua)) return de.devices.mac;
  if (/Windows/.test(ua)) return de.devices.windows;
  if (/Linux|X11|CrOS/.test(ua)) return de.devices.linux;
  return de.devices.fallback;
}
