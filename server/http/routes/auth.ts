import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PasskeyError, type Passkey, type PasskeyErrorCode } from '../../auth/passkeys';
import type { AppDeps } from '../app';
import {
  HttpError,
  clearSessionCookie,
  clientIp,
  requireSession,
  sessionToken,
  setSessionCookie,
} from '../guards';

/** Per IP on the unauthenticated ceremony routes (setup + login). */
const authRateLimit = { rateLimit: { max: 10, timeWindow: 60_000 } };

/** HTTP status and client error code of each PasskeyError. */
const STATUS: Record<PasskeyErrorCode, [number, string]> = {
  CHALLENGE: [400, 'CHALLENGE'],
  VERIFY: [400, 'VERIFY'],
  // Thrown for an invalid setup link: the same answer as the route's own check.
  FORBIDDEN: [403, 'SETUP_DENIED'],
  DUPLICATE: [409, 'DUPLICATE'],
  NOT_FOUND: [404, 'PASSKEY_NOT_FOUND'],
  LAST_PASSKEY: [409, 'LAST_PASSKEY'],
  STEP_UP: [403, 'STEP_UP'],
};

/** Runs `fn`, turning PasskeyErrors into HttpErrors with the matching status and code. */
async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PasskeyError) throw new HttpError(STATUS[err.code][0], err.message, STATUS[err.code][1]);
    throw err;
  }
}

const str = (maxLength: number) => ({ type: 'string', maxLength }) as const;
const registration = {
  type: 'object',
  required: ['challengeId', 'response'],
  properties: { challengeId: str(100), response: { type: 'object' }, name: str(200) },
} as const;

interface RegistrationBody {
  challengeId: string;
  response: object;
  name?: string;
}

/** Public view of a passkey (no key material). */
const view = ({ id, name, transports, createdAt, lastUsed }: Passkey) => ({ id, name, transports, createdAt, lastUsed });

const SETUP_DENIED = 'Einrichtungslink ungültig oder abgelaufen';

export async function authRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { config, sessions, setup, passkeys } = deps;
  const authed = { preHandler: requireSession(sessions, config) };
  const ip = (req: FastifyRequest) => clientIp(req, config);

  async function startSession(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const ua = req.headers['user-agent'];
    const token = await sessions.create({
      userAgent: typeof ua === 'string' ? ua.slice(0, 300) : '',
      ip: ip(req),
    });
    setSessionCookie(reply, token, config);
  }

  // Docker's healthcheck polls this every 30 s; keep it out of the request log.
  app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));

  app.get('/api/auth/state', async (req) => {
    const token = sessionToken(req, config);
    return {
      authenticated: token ? (await sessions.validate(token)) !== null : false,
      setupRequired: !(await passkeys.hasPasskeys()),
      // The app only works under this origin (Origin check, WebAuthn); the client points there otherwise.
      publicOrigin: config.publicUrl.origin,
    };
  });

  // --- Setup (first passkey, or another one via a CLI setup link) ---

  app.post<{ Body: { token?: string } }>(
    '/api/auth/setup/options',
    { config: authRateLimit, schema: { body: { type: 'object', properties: { token: str(200) } } } },
    async (req) => {
      if (!(await setup.check(req.body.token ?? ''))) throw new HttpError(403, SETUP_DENIED, 'SETUP_DENIED');
      return passkeys.registrationOptions(ip(req));
    },
  );

  app.post<{ Body: RegistrationBody & { token?: string } }>(
    '/api/auth/setup/verify',
    {
      config: authRateLimit,
      schema: { body: { ...registration, properties: { ...registration.properties, token: str(200) } } },
    },
    async (req, reply) => {
      const token = req.body.token ?? '';
      if (!(await setup.check(token))) throw new HttpError(403, SETUP_DENIED, 'SETUP_DENIED');
      const passkey = await mapped(() =>
        passkeys.finishRegistration(req.body.challengeId, req.body.response, req.body.name ?? '', () =>
          setup.consume(token),
        ),
      );
      await startSession(req, reply);
      return view(passkey);
    },
  );

  // --- Login ---

  app.post('/api/auth/login/options', { config: authRateLimit }, async (req) => passkeys.authenticationOptions(ip(req)));

  app.post<{ Body: { challengeId: string; response: object } }>(
    '/api/auth/login/verify',
    {
      config: authRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['challengeId', 'response'],
          properties: { challengeId: str(100), response: { type: 'object' } },
        },
      },
    },
    async (req, reply) => {
      const ok = await mapped(() => passkeys.finishAuthentication(req.body.challengeId, req.body.response));
      if (!ok) throw new HttpError(401, 'Anmeldung fehlgeschlagen', 'LOGIN_FAILED');
      await startSession(req, reply);
      return { ok: true };
    },
  );

  app.post('/api/auth/logout', async (req, reply) => {
    const token = sessionToken(req, config);
    const session = token ? await sessions.validate(token) : null;
    if (session) await sessions.revoke(session.id);
    clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  // --- Passkey management (session required) ---

  app.get('/api/auth/passkeys', authed, async () => (await passkeys.list()).map(view));

  // Adding a passkey: first confirm with an existing one (user verification), then register.
  // Rate-limited like login: the confirmation is a full authentication ceremony.
  app.post('/api/auth/passkeys/confirm/options', { ...authed, config: authRateLimit }, async (req) =>
    passkeys.confirmationOptions(req.session!.id, ip(req)),
  );

  app.post<{ Body: { challengeId: string; response: object } }>(
    '/api/auth/passkeys/confirm',
    {
      ...authed,
      config: authRateLimit,
      schema: {
        body: {
          type: 'object',
          required: ['challengeId', 'response'],
          properties: { challengeId: str(100), response: { type: 'object' } },
        },
      },
    },
    async (req) => {
      const ok = await mapped(() => passkeys.finishConfirmation(req.session!.id, req.body.challengeId, req.body.response));
      if (!ok) throw new HttpError(401, 'Bestätigung fehlgeschlagen', 'CONFIRM_FAILED');
      return { ok: true };
    },
  );

  app.post('/api/auth/passkeys/options', authed, async (req) =>
    mapped(() => passkeys.addOptions(req.session!.id, ip(req))),
  );

  app.post<{ Body: RegistrationBody }>('/api/auth/passkeys', { ...authed, schema: { body: registration } }, async (req) =>
    view(
      await mapped(() =>
        passkeys.finishRegistration(req.body.challengeId, req.body.response, req.body.name ?? '', undefined, req.session!.id),
      ),
    ),
  );

  app.patch<{ Params: { id: string }; Body: { name: string } }>(
    '/api/auth/passkeys/:id',
    {
      ...authed,
      schema: { body: { type: 'object', required: ['name'], properties: { name: { ...str(200), minLength: 1 } } } },
    },
    async (req, reply) => {
      await mapped(() => passkeys.rename(req.params.id, req.body.name));
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>(
    '/api/auth/passkeys/:id',
    { ...authed, schema: { querystring: { type: 'object', properties: { force: str(10) } } } },
    async (req, reply) => {
      await mapped(() => passkeys.remove(req.params.id, { force: req.query.force === '1' }));
      return reply.code(204).send();
    },
  );

  // --- Sessions (session required) ---

  app.get('/api/auth/sessions', authed, async (req) =>
    (await sessions.list()).map((s) => ({ ...s, current: s.id === req.session!.id })),
  );

  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', authed, async (req, reply) => {
    const { id } = req.params;
    if (!(await sessions.list()).some((s) => s.id === id)) throw new HttpError(404, 'Sitzung nicht gefunden', 'SESSION_NOT_FOUND');
    await sessions.revoke(id);
    if (id === req.session!.id) clearSessionCookie(reply, config);
    return reply.code(204).send();
  });

  app.post('/api/auth/sessions/revoke-others', authed, async (req, reply) => {
    await sessions.revokeAll(req.session!.id);
    return reply.code(204).send();
  });
}
