import type { FastifyReply, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { Session, SessionStore } from '../auth/sessions';
import type { Config } from '../config';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireSession`. */
    session?: Session;
  }
}

/**
 * Error with an HTTP status. The client gets `{ error: message, code }`: `code` is the stable,
 * machine-readable reason (e.g. `ORIGIN`) the web app translates; `error` stays German for
 * older clients and logs.
 */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Session cookie name over plain http (localhost development) and before the `__Host-` migration. */
export const LEGACY_SESSION_COOKIE = 'vw_session';
/**
 * Over https the cookie carries the `__Host-` prefix: the browser then only accepts it with
 * `Secure`, `Path=/` and without `Domain`, so a sibling subdomain cannot plant or overwrite it.
 * Browsers refuse `__Host-` cookies on http://localhost in some versions, hence only for https.
 */
export const HOST_SESSION_COOKIE = '__Host-vw_session';

type CookieConfig = Pick<Config, 'publicUrl' | 'sessionDays'>;

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/',
} as const;

const usesHostPrefix = (publicUrl: URL) => publicUrl.protocol === 'https:';

/** Name of the session cookie for this deployment. */
export const sessionCookieName = (publicUrl: URL): string =>
  usesHostPrefix(publicUrl) ? HOST_SESSION_COOKIE : LEGACY_SESSION_COOKIE;

export function setSessionCookie(reply: FastifyReply, token: string, config: CookieConfig): void {
  reply.setCookie(sessionCookieName(config.publicUrl), token, { ...cookieOptions, maxAge: config.sessionDays * 86400 });
}

/** Clears the session cookie (and over https the pre-migration `vw_session` as well). */
export function clearSessionCookie(reply: FastifyReply, config: Pick<Config, 'publicUrl'>): void {
  reply.clearCookie(sessionCookieName(config.publicUrl), cookieOptions);
  if (usesHostPrefix(config.publicUrl)) reply.clearCookie(LEGACY_SESSION_COOKIE, cookieOptions);
}

/**
 * Session cookie of the request, if any. Over https a cookie of the old name (`vw_session`, set
 * before the `__Host-` prefix) is still accepted; `requireSession` re-issues it under the new name.
 */
export function sessionToken(req: FastifyRequest, config: Pick<Config, 'publicUrl'>): string | undefined {
  const current = req.cookies[sessionCookieName(config.publicUrl)];
  if (current) return current;
  return usesHostPrefix(config.publicUrl) ? req.cookies[LEGACY_SESSION_COOKIE] || undefined : undefined;
}

const proxyTrusted = (trustProxy: Config['trustProxy']): boolean =>
  trustProxy === true || (typeof trustProxy === 'number' && trustProxy > 0) || (Array.isArray(trustProxy) && trustProxy.length > 0);

/**
 * Client IP: Fastify's `req.ip` (honours X-Forwarded-For according to TRUST_PROXY).
 * `CF-Connecting-IP` only counts with TRUST_CF_CONNECTING_IP=true (Cloudflare Tunnel/Proxy) and a
 * trusted proxy; otherwise any client could pick its own rate-limit key with that header.
 */
export function clientIp(req: FastifyRequest, config: Pick<Config, 'trustProxy' | 'trustCfConnectingIp'>): string {
  if (config.trustCfConnectingIp && proxyTrusted(config.trustProxy)) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.trim() !== '') return cf.trim();
  }
  return req.ip;
}

/** Unsafe methods (POST/PUT/PATCH/DELETE) only with `Origin` exactly equal to the PUBLIC_URL origin. */
export function requireSameOrigin(publicUrl: URL): onRequestHookHandler {
  const expected = publicUrl.origin;
  return async (req) => {
    if (!UNSAFE_METHODS.has(req.method)) return;
    if (req.headers.origin !== expected) throw new HttpError(403, 'Anfrage von fremder Herkunft abgelehnt', 'ORIGIN');
  };
}

/**
 * Requires a valid session cookie and sets `req.session`. Renews the cookie's Max-Age on every
 * authenticated request (the server-side expiry slides as well).
 */
export function requireSession(
  sessions: SessionStore,
  config: CookieConfig,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const name = sessionCookieName(config.publicUrl);
  return async (req, reply) => {
    const token = sessionToken(req, config);
    const session = token ? await sessions.validate(token) : null;
    if (!token || !session) {
      if (token) clearSessionCookie(reply, config);
      throw new HttpError(401, 'Nicht angemeldet', 'UNAUTHENTICATED');
    }
    req.session = session;
    setSessionCookie(reply, token, config);
    // Migrated from the old cookie name: drop the old cookie, the new one replaces it.
    if (name !== LEGACY_SESSION_COOKIE && !req.cookies[name]) reply.clearCookie(LEGACY_SESSION_COOKIE, cookieOptions);
  };
}
