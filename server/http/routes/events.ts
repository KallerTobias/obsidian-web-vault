import { PassThrough } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { VaultEvent } from '../../events';
import type { AppDeps } from '../app';
import { sessionToken } from '../guards';

export interface EventRouteDeps extends AppDeps {
  heartbeatMs: number;
}

/** Open event streams per session (a browser needs one per tab); more is refused with 429. */
export const MAX_STREAMS_PER_SESSION = 10;

/**
 * Events since `seq`, or 'gap' when the client cannot be caught up: the ring buffer no longer
 * covers it, or `seq` lies in the future (server restarted, counter began anew).
 */
function eventsSince(events: AppDeps['events'], seq: number): VaultEvent[] | 'gap' {
  return seq > events.seq ? 'gap' : events.since(seq);
}

const frame = (id: number, event: string, data: unknown) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export async function eventRoutes(app: FastifyInstance, deps: EventRouteDeps): Promise<void> {
  const { events, sessions, heartbeatMs, config } = deps;
  /** Cleanup of every open stream; run on app close so shutdown does not wait for clients. */
  const open = new Set<() => void>();
  /** Open streams per session id. */
  const perSession = new Map<string, number>();
  app.addHook('preClose', async () => {
    for (const close of [...open]) close();
  });

  app.get<{ Querystring: { since: string } }>(
    '/api/changes',
    {
      schema: {
        querystring: { type: 'object', required: ['since'], properties: { since: { type: 'string', pattern: '^[0-9]{1,15}$' } } },
      },
    },
    async (req) => {
      const r = eventsSince(events, Number(req.query.since));
      return r === 'gap' ? { resync: true, seq: events.seq } : { seq: events.seq, events: r };
    },
  );

  /**
   * Server-sent events: `id: <seq>`, `event: <type>`, data = the event as JSON. With
   * `Last-Event-ID` missed events are replayed first (or `resync` if impossible); then `ready`
   * carries the current seq as id, so even an idle client reconnects with a valid Last-Event-ID.
   */
  app.get('/api/events', async (req, reply) => {
    // The client may have gone away while the (async) request hooks ran: 'close' has already fired.
    if (req.raw.destroyed || reply.raw.destroyed || req.raw.socket?.destroyed) return reply.code(204).send();
    const sessionId = req.session!.id;
    const streams = perSession.get(sessionId) ?? 0;
    if (streams >= MAX_STREAMS_PER_SESSION) {
      return reply.code(429).send({ error: 'Zu viele offene Verbindungen, bitte andere Tabs schließen', code: 'TOO_MANY_STREAMS' });
    }
    perSession.set(sessionId, streams + 1);
    const token = sessionToken(req, config) ?? '';
    const header = req.headers['last-event-id'];
    const lastId = typeof header === 'string' && /^[0-9]{1,15}$/.test(header.trim()) ? Number(header.trim()) : undefined;
    const stream = new PassThrough();
    const write = (chunk: string) => {
      if (!stream.writableEnded) stream.write(chunk);
    };

    let last = events.seq;
    const send = (e: VaultEvent) => {
      if (e.seq <= last) return;
      last = e.seq;
      write(frame(e.seq, e.type, e));
    };
    // Replay and subscribe in the same tick: no event can slip in between.
    if (lastId !== undefined) {
      const r = eventsSince(events, lastId);
      if (r === 'gap') write(frame(events.seq, 'resync', { seq: events.seq }));
      else {
        last = lastId;
        r.forEach(send);
      }
    }
    write(frame(events.seq, 'ready', { seq: events.seq }));
    const unsubscribe = events.subscribe(send);
    // Each heartbeat re-checks the session (read-only): a revoked or expired session ends the stream.
    const timer = setInterval(() => {
      sessions.peek(token).then(
        (s) => (s ? write(': ping\n\n') : close()),
        (err: unknown) => {
          req.log.error({ err }, 'Sitzungsprüfung für Ereignisstrom fehlgeschlagen');
          close();
        },
      );
    }, heartbeatMs);
    timer.unref();

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      const left = (perSession.get(sessionId) ?? 1) - 1;
      if (left > 0) perSession.set(sessionId, left);
      else perSession.delete(sessionId);
      unsubscribe();
      clearInterval(timer);
      open.delete(close);
      stream.end();
    };
    open.add(close);
    reply.raw.once('close', close);
    stream.once('close', close);

    return reply
      .header('content-type', 'text/event-stream; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-accel-buffering', 'no')
      .send(stream);
  });
}
