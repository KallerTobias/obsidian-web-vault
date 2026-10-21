import type { FastifyInstance } from 'fastify';
import { basename, stripMd } from '@shared/normalize';
import { resolveLink } from '@shared/resolve';
import type { AppDeps } from '../app';
import { HttpError } from '../guards';
import { mapVaultErrors } from '../vault-errors';
import { normalizeRel } from '../../vault/paths';

const pathStr = { type: 'string', maxLength: 1024 } as const;
const pathQuery = { type: 'object', required: ['path'], properties: { path: pathStr } } as const;
const collator = new Intl.Collator('de', { numeric: true });

export async function indexRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { index, search } = deps;
  mapVaultErrors(app);

  app.get<{ Querystring: { path: string } }>('/api/backlinks', { schema: { querystring: pathQuery } }, async (req) => {
    const path = normalizeRel(req.query.path);
    return { linked: index.backlinks(path), unlinked: index.unlinkedMentions(path) };
  });

  app.get<{ Querystring: { path: string } }>('/api/meta', { schema: { querystring: pathQuery } }, async (req) => {
    const note = index.note(normalizeRel(req.query.path));
    if (!note) throw new HttpError(404, 'Nicht gefunden', 'NOT_FOUND');
    return note;
  });

  app.get<{ Querystring: { target: string; from?: string } }>(
    '/api/resolve',
    {
      schema: {
        querystring: { type: 'object', required: ['target'], properties: { target: pathStr, from: pathStr } },
      },
    },
    async (req) => ({ path: resolveLink(req.query.target, normalizeRel(req.query.from ?? ''), index.lookup()) }),
  );

  /** Every indexed file for quick switcher and link completion. */
  app.get('/api/lookup', async () =>
    [...index.lookup().byPath.values()].sort(collator.compare).map((path) => {
      const note = index.note(path);
      if (!note) return { path, name: basename(path), aliases: [] };
      return {
        path,
        name: stripMd(basename(path)),
        aliases: note.aliases,
        headings: note.headings.map(({ level, text }) => ({ level, text })),
      };
    }),
  );

  app.get<{ Querystring: { q: string; limit?: string } }>(
    '/api/search',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', maxLength: 1000 }, limit: { type: 'string', pattern: '^[0-9]{1,4}$' } },
        },
      },
    },
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 200);
      return search.search(req.query.q, limit);
    },
  );

  app.get('/api/tags', async () =>
    [...index.tags()].map(([tag, count]) => ({ tag, count })).sort((a, b) => collator.compare(a.tag, b.tag)),
  );

  app.get('/api/graph', async () => index.graph());
}
