import type { FastifyInstance } from 'fastify';
import type { Settings } from '../../store/settings';
import type { AppDeps } from '../app';

const str = { type: 'string', maxLength: 1024 } as const;
const num = { type: 'number', minimum: 0, maximum: 100 } as const;

/** Partial Settings: every key optional, unknown keys and wrong types rejected. */
const settingsPatch = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentFolder: str,
    newLinkFormat: { enum: ['shortest', 'absolute', 'relative'] },
    templatesFolder: str,
    dailyNotes: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, folder: str, format: { type: 'string', maxLength: 100 }, template: str },
    },
    newNoteFolder: str,
    theme: { enum: ['system', 'light', 'dark'] },
    graph: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { enum: ['2d', '3d'] },
        filter: str,
        showTags: { type: 'boolean' },
        showAttachments: { type: 'boolean' },
        showOrphans: { type: 'boolean' },
        groups: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['query', 'color'],
            properties: { query: str, color: { type: 'string', maxLength: 50 } },
          },
        },
        repel: num,
        linkDistance: num,
        center: num,
        nodeSize: num,
        localDepth: { type: 'integer', minimum: 1, maximum: 10 },
      },
    },
  },
} as const;

type SettingsPatch = Partial<Omit<Settings, 'dailyNotes' | 'graph'>> & {
  dailyNotes?: Partial<Settings['dailyNotes']>;
  graph?: Partial<Settings['graph']>;
};

export async function settingsRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { settings } = deps;

  app.get('/api/settings', async () => {
    await settings.refresh();
    return settings.get();
  });

  app.put<{ Body: SettingsPatch }>('/api/settings', { schema: { body: settingsPatch } }, async (req) => {
    const { dailyNotes, graph, ...flat } = req.body;
    return settings.update((s) => {
      Object.assign(s, flat);
      if (dailyNotes) Object.assign(s.dailyNotes, dailyNotes);
      if (graph) Object.assign(s.graph, graph);
    });
  });
}
