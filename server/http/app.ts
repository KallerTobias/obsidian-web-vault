import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { PasskeyService } from '../auth/passkeys';
import type { SessionStore } from '../auth/sessions';
import type { SetupTokens } from '../auth/setup-token';
import type { Config } from '../config';
import type { EventBus } from '../events';
import type { SearchIndex } from '../index/search';
import type { VaultIndex } from '../index/vault-index';
import type { JsonStore } from '../store/json-store';
import type { Settings } from '../store/settings';
import type { VaultFiles } from '../vault/files';
import type { OwnChangeMarker, VaultOps } from '../vault/ops';
import type { VaultPaths } from '../vault/paths';
import { HttpError, clientIp, requireSameOrigin, requireSession } from './guards';
import { authRoutes } from './routes/auth';
import { eventRoutes } from './routes/events';
import { fileRoutes } from './routes/files';
import { indexRoutes } from './routes/index';
import { settingsRoutes } from './routes/settings';

export interface AppDeps {
  config: Config;
  sessions: SessionStore;
  paths: VaultPaths;
  setup: SetupTokens;
  passkeys: PasskeyService;
  files: VaultFiles;
  ops: VaultOps;
  index: VaultIndex;
  search: SearchIndex;
  events: EventBus;
  settings: JsonStore<Settings>;
  /** The vault watcher: API writes are marked so it does not report them a second time. */
  watcher: OwnChangeMarker;
}

export interface AppOptions {
  /** `false` disables logging; otherwise level/stream (redaction is always applied). */
  logger?: false | { level?: string; stream?: NodeJS.WritableStream };
  /** Interval of the SSE heartbeat comment (default 25 s). */
  sseHeartbeatMs?: number;
  /** Built web app (`dist/web`) to serve with SPA fallback; skipped when absent or missing. */
  webDir?: string;
}

/** Upload limit of `POST /api/attachment`. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Default deny: every `/api` route needs a session except `/api/health` and `/api/auth/*` (the
 * latter guard their management routes themselves). Decided on the matched route pattern, so
 * encoded or unusual URLs cannot dodge it; unmatched URLs (404) are judged by their path.
 */
function needsSession(req: FastifyRequest): boolean {
  const route = req.routeOptions.url ?? req.url.split('?')[0]!;
  if (route !== '/api' && !route.startsWith('/api/')) return false;
  return route !== '/api/health' && !route.startsWith('/api/auth/');
}

/** Never log cookies, tokens or credentials. */
const REDACT = {
  paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', 'req.body'],
  censor: '[entfernt]',
};

/**
 * Fastify ≥ 5.x ignores X-Forwarded-For entirely for a numeric hop count (fails closed). TRUST_PROXY
 * documents hop counts, so they are expressed as the equivalent trust function: the nearest
 * `hops` addresses (socket peer first) are trusted proxies – as spoofable as `true` if the port is
 * reachable without the proxy, exactly like Express' hop-count semantics.
 */
function fastifyTrustProxy(tp: Config['trustProxy']): boolean | string[] | ((addr: string, i: number) => boolean) {
  if (typeof tp === 'number') return (_addr, i) => i < tp;
  return tp;
}

/**
 * Serves the built web app. `wildcard: false` registers one route per file found at startup
 * (no `/*` route that would match unknown `/api/*` URLs). Hashed files under `assets/` are
 * immutable; everything else (index.html) is revalidated.
 */
function registerWebApp(app: FastifyInstance, root: string): void {
  app.register(fastifyStatic, {
    root,
    wildcard: false,
    index: ['index.html'],
    cacheControl: false,
    setHeaders: (reply, file) => {
      const assets = relative(root, file).split(sep)[0] === 'assets';
      reply.header('cache-control', assets ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
}

/** Client-side routes (`/setup`, later note URLs): browser navigations outside `/api`. */
function wantsSpa(req: FastifyRequest): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const path = req.url.split('?')[0]!;
  if (path === '/api' || path.startsWith('/api/')) return false;
  return (req.headers.accept ?? '').includes('text/html');
}

/** Builds the HTTP app without side effects (no listen); tests use `inject`. */
export function buildApp(deps: AppDeps, opts: AppOptions = {}): FastifyInstance {
  const { config } = deps;
  const log = opts.logger ?? {};
  const app = Fastify({
    logger: log === false ? false : { level: log.level ?? 'info', redact: REDACT, ...(log.stream ? { stream: log.stream } : {}) },
    trustProxy: fastifyTrustProxy(config.trustProxy),
    // No type coercion: `5` is not a valid string id. Unknown properties are rejected, not dropped.
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });

  app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // Recorded ruling: Mermaid/KaTeX/Svelte set inline styles.
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.register(cookie);
  app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, fieldSize: 4096, parts: 11, headerPairs: 100 },
  });
  app.register(rateLimit, {
    global: false,
    keyGenerator: (req) => clientIp(req, config),
    errorResponseBuilder: () => new HttpError(429, 'Zu viele Versuche, bitte eine Minute warten'),
  });

  app.addHook('onRequest', requireSameOrigin(config.publicUrl));
  const session = requireSession(deps.sessions, config);
  app.addHook('onRequest', async (req, reply) => {
    if (needsSession(req)) await session(req, reply);
  });

  app.setErrorHandler((err: FastifyError | HttpError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...(err.code ? { code: err.code } : {}) });
    }
    const status = err.statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: 'Zu viele Anfragen' });
    if (status === 413) return reply.code(413).send({ error: 'Anfrage zu groß' });
    if (status >= 400 && status < 500) return reply.code(status).send({ error: 'Ungültige Anfrage' });
    req.log.error({ err }, 'Unerwarteter Fehler');
    return reply.code(500).send({ error: 'Interner Fehler' });
  });
  const webDir = opts.webDir !== undefined && existsSync(join(opts.webDir, 'index.html')) ? opts.webDir : undefined;
  if (webDir) registerWebApp(app, webDir);
  app.setNotFoundHandler((req, reply) => {
    if (webDir && wantsSpa(req)) {
      return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Nicht gefunden' });
  });

  app.register(authRoutes, deps);
  app.register(fileRoutes, deps);
  app.register(indexRoutes, deps);
  app.register(eventRoutes, { ...deps, heartbeatMs: opts.sseHeartbeatMs ?? 25_000 });
  app.register(settingsRoutes, deps);
  return app;
}
