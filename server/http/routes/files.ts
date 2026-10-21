import { lstat } from 'node:fs/promises';
import dayjs from 'dayjs';
import type { FastifyInstance } from 'fastify';
import { basename, dirname, nfc } from '@shared/normalize';
import type { AppDeps } from '../app';
import { HttpError } from '../guards';
import { mapVaultErrors } from '../vault-errors';
import { ConflictError, type StagedFile, type Version } from '../../vault/files';
import { normalizeRel } from '../../vault/paths';

const PATH_MAX = 1024;
/** Largest file `GET /api/note` loads into memory. */
const NOTE_READ_MAX = 10 * 1024 * 1024;
const isText = (mime: string) => mime.startsWith('text/') || mime === 'application/json';
/** Note content up to 10 MB plus room for the JSON envelope. */
const NOTE_BODY_LIMIT = 10 * 1024 * 1024 + 64 * 1024;

const pathStr = { type: 'string', maxLength: PATH_MAX } as const;
const pathQuery = { type: 'object', required: ['path'], properties: { path: pathStr } } as const;

const isNote = (p: string) => p.toLowerCase().endsWith('.md');

const PASTED_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Safe file name from an upload: no path components, none of `\ / : * ? " < > |`, no control
 * characters, no leading dots (hidden files) or trailing dots/spaces; the extension is kept.
 */
export function sanitizeFileName(raw: string): string {
  const last = nfc(raw).split(/[\\/]/).pop() ?? '';
  const name = last
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[#^[\]]/g, '-') // would break wiki links to the attachment
    .trim();
  const ext = /\.[^.\s]{1,16}$/.exec(name)?.[0] ?? '';
  let stem = name.slice(0, name.length - ext.length).replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  stem = stem.slice(0, 180).trim();
  return `${stem || 'Anhang'}${ext}`;
}

/**
 * Characters a *new* file or folder name must not contain: `# ^ [ ] |` break wiki links
 * (`[[Plan #2]]` = heading "2" of "Plan"), `\ : * ? " < > |` are invalid on Windows/macOS
 * (Obsidian forbids all of them), control characters are never wanted.
 */
const FORBIDDEN_NAME = /[\\:*?"<>|#^[\]\u0000-\u001f\u007f-\u009f]/;

const FORBIDDEN_NAME_ERROR = 'Der Name darf keines dieser Zeichen enthalten: \\ : * ? " < > | # ^ [ ]';

/** Rejects `path` if its last segment is a new name with forbidden characters (existing names may keep them). */
function assertValidNewName(path: string): void {
  if (FORBIDDEN_NAME.test(basename(path))) throw new HttpError(400, FORBIDDEN_NAME_ERROR);
}

/**
 * Rejects `path` if any segment that does not exist yet (and would be created, e.g. a new parent
 * folder) has forbidden characters. Existing folders may keep their names.
 */
async function assertValidNewSegments(paths: AppDeps['paths'], path: string): Promise<void> {
  const segs = path.split('/');
  for (let i = 0; i < segs.length; i++) {
    const prefix = segs.slice(0, i + 1).join('/');
    const exists = await paths.safeResolve(prefix).then(
      (abs) => lstat(abs).then(() => true, () => false),
      () => false,
    );
    if (exists) continue;
    // From here on every segment is new.
    if (segs.slice(i).some((s) => FORBIDDEN_NAME.test(s))) throw new HttpError(400, FORBIDDEN_NAME_ERROR);
    return;
  }
}

/** Folder for a note's attachments: '' = vault root, './' = the note's folder, './sub' below it, else a vault path. */
export function attachmentDir(setting: string, notePath: string): string {
  const s = setting.trim();
  const noteDir = dirname(notePath);
  if (s === '' || s === '/') return '';
  if (s === '.' || s === './') return noteDir;
  if (s.startsWith('./')) return normalizeRel(noteDir ? `${noteDir}/${s.slice(2)}` : s.slice(2));
  return normalizeRel(s);
}

/** `inline` only for media the browser shows itself; the file name RFC 5987-encoded plus ASCII fallback. */
function contentDisposition(mime: string, name: string): string {
  const inline = /^(image|audio|video)\//.test(mime) || mime === 'application/pdf';
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Single `bytes=` range; undefined = serve everything (absent or unsupported), 'invalid' = 416. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  const m = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!m || (m[1] === '' && m[2] === '')) return undefined;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? 'invalid' : { start, end };
}

export async function fileRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { paths, files, ops, index, search, events, settings, watcher } = deps;
  mapVaultErrors(app);

  /** After a successful API write: tell the watcher, update index/search, inform other clients. */
  function recordWrite(path: string, data: Buffer | string, version: Version, type: 'created' | 'changed'): void {
    watcher.markOwnWrite(path, version);
    if (isNote(path)) {
      const text = data.toString();
      index.upsert(path, text);
      search.upsert(path, text, [...new Set((index.note(path)?.tags ?? []).map((t) => t.tag))]);
    } else index.addFile(path);
    events.publish({ type, path, version });
  }

  const conflict = (err: ConflictError) => ({
    error: 'Konflikt: Datei wurde zwischenzeitlich geändert',
    diskContent: err.diskContent,
    diskVersion: err.diskVersion,
  });

  app.get('/api/tree', async () => files.tree());

  app.get<{ Querystring: { path: string } }>('/api/note', { schema: { querystring: pathQuery } }, async (req) => {
    const path = normalizeRel(req.query.path);
    const { size, mime } = await files.openBytes(path);
    if (!isText(mime)) throw new HttpError(400, 'Keine Textdatei');
    if (size > NOTE_READ_MAX) throw new HttpError(413, 'Datei zu groß zum Bearbeiten');
    const { content, version } = await files.read(path);
    return { content, version, readonly: paths.isReadonly(path) };
  });

  app.put<{ Querystring: { path: string }; Body: { content: string; baseVersion: string } }>(
    '/api/note',
    {
      bodyLimit: NOTE_BODY_LIMIT,
      schema: {
        querystring: pathQuery,
        body: {
          type: 'object',
          required: ['content', 'baseVersion'],
          properties: { content: { type: 'string' }, baseVersion: { type: 'string', maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const path = normalizeRel(req.query.path);
      let version: Version;
      try {
        version = await files.write(path, req.body.content, req.body.baseVersion);
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send(conflict(err));
        throw err;
      }
      recordWrite(path, req.body.content, version, 'changed');
      return { version };
    },
  );

  app.post<{ Body: { path: string; content: string } }>(
    '/api/note',
    {
      bodyLimit: NOTE_BODY_LIMIT,
      schema: {
        body: {
          type: 'object',
          required: ['path', 'content'],
          properties: { path: { ...pathStr, minLength: 1 }, content: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      const path = normalizeRel(req.body.path);
      if (path === '') throw new HttpError(400, 'Ungültiger Pfad');
      await assertValidNewSegments(paths, path);
      let version: Version;
      try {
        version = await files.create(path, req.body.content);
      } catch (err) {
        if (err instanceof ConflictError) return reply.code(409).send(conflict(err));
        throw err;
      }
      recordWrite(path, req.body.content, version, 'created');
      return { path, version };
    },
  );

  app.post<{ Body: { path: string } }>(
    '/api/folder',
    { schema: { body: { type: 'object', required: ['path'], properties: { path: pathStr } } } },
    async (req) => {
      const path = normalizeRel(req.body.path);
      if (path === '') throw new HttpError(400, 'Ungültiger Pfad');
      await assertValidNewSegments(paths, path);
      if (await files.mkdir(path)) events.publish({ type: 'created', path });
      return { path };
    },
  );

  app.post<{ Body: { from: string; to: string; updateLinks: boolean } }>(
    '/api/rename',
    {
      schema: {
        body: {
          type: 'object',
          required: ['from', 'to', 'updateLinks'],
          properties: { from: pathStr, to: pathStr, updateLinks: { type: 'boolean' } },
        },
      },
    },
    async (req) => {
      const from = normalizeRel(req.body.from);
      const to = normalizeRel(req.body.to);
      if (from !== '' && to.startsWith(`${from}/`)) {
        throw new HttpError(400, 'Ein Ordner kann nicht in sich selbst verschoben werden');
      }
      // Moving keeps the name (even an old one with `#`); a changed name must be valid.
      if (basename(to) !== basename(from)) assertValidNewName(to);
      return ops.rename(from, to, req.body.updateLinks);
    },
  );

  app.get<{ Querystring: { path: string } }>('/api/rename/affected', { schema: { querystring: pathQuery } }, async (req) => {
    const affected = ops.affectedBy(normalizeRel(req.query.path));
    return { count: affected.length, paths: affected };
  });

  app.delete<{ Querystring: { path: string } }>('/api/entry', { schema: { querystring: pathQuery } }, async (req, reply) => {
    await ops.trash(req.query.path);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { path: string } }>('/api/file', { schema: { querystring: pathQuery } }, async (req, reply) => {
    const path = normalizeRel(req.query.path);
    const file = await files.openBytes(path);
    reply
      .header('content-type', file.mime)
      .header('cache-control', 'private, no-cache')
      .header('x-content-type-options', 'nosniff')
      .header('accept-ranges', 'bytes')
      .header('content-disposition', contentDisposition(file.mime, basename(path)));
    // SVG can carry scripts: opened directly it must not run in our origin.
    if (file.mime === 'image/svg+xml') reply.header('content-security-policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    // The app shows PDFs in an iframe. Only our own pages may frame them; no `sandbox`/`default-src`,
    // which break the browsers' built-in PDF viewers. A PDF runs no script in our origin.
    if (file.mime === 'application/pdf') reply.header('content-security-policy', "frame-ancestors 'self'");
    const range = parseRange(req.headers.range, file.size);
    if (range === 'invalid') {
      reply.removeHeader('content-disposition');
      return reply
        .code(416)
        .type('application/json; charset=utf-8')
        .header('content-range', `bytes */${file.size}`)
        .send({ error: 'Ungültiger Bereich' });
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${file.size}`)
        .header('content-length', range.end - range.start + 1)
        .send(file.stream(range));
    }
    return reply.header('content-length', file.size).send(file.stream());
  });

  app.post('/api/attachment', async (req) => {
    let notePath = '';
    let pasted = false;
    // Streamed to a hidden temp file in the vault (never buffered): the target folder may only be
    // known after all fields arrived.
    let upload: { filename: string; mimetype: string; staged: StagedFile } | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || upload) {
            part.file.resume(); // not ours: drain
            continue;
          }
          const staged = await files.stageUpload(part.file);
          upload = { filename: part.filename, mimetype: part.mimetype, staged };
          if (part.file.truncated) throw new HttpError(413, 'Anfrage zu groß');
          continue;
        }
        if (part.valueTruncated || typeof part.value !== 'string') throw new HttpError(400, 'Ungültige Anfrage');
        if (part.fieldname === 'notePath') {
          if (part.value.length > PATH_MAX) throw new HttpError(400, 'Ungültiger Pfad');
          notePath = part.value;
        } else if (part.fieldname === 'pasted') pasted = part.value === '1' || part.value === 'true';
      }
      if (!upload) throw new HttpError(400, 'Keine Datei übergeben');
      const note = normalizeRel(notePath);

      const name = pasted
        ? `Pasted image ${dayjs().format('YYYYMMDDHHmmss')}${PASTED_EXT[upload.mimetype] ?? '.png'}`
        : sanitizeFileName(upload.filename);
      let folderSetting: string;
      try {
        await settings.refresh();
        folderSetting = settings.get().attachmentFolder;
      } catch (err) {
        // DATA_DIR problem, not a vault one: must stay a 500, not be mapped like a vault errno.
        throw new Error('Einstellungen nicht lesbar', { cause: err });
      }
      const dir = attachmentDir(folderSetting, note);
      if (dir !== '') await files.mkdir(dir);

      // A concurrent upload may take the free name between check and write: try the next one.
      for (let attempt = 0; ; attempt++) {
        const target = await files.uniquePath(dir ? `${dir}/${name}` : name);
        try {
          await files.createFromStaged(target, upload.staged);
        } catch (err) {
          if (err instanceof ConflictError && attempt < 5) continue;
          throw err;
        }
        // An uploaded `.md` becomes a note: index its text (lossy is fine, the index never writes).
        const text = isNote(target) ? (await files.read(target, { lossy: true })).content : '';
        recordWrite(target, text, upload.staged.version, 'created');
        return { path: target };
      }
    } finally {
      await upload?.staged.discard();
    }
  });

}
