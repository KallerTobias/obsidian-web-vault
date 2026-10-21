import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../web/src/lib/api';
import { createFromTemplate, InvalidNoteNameError, newNotePath, openDailyNote, type NewNoteDeps } from '../../web/src/lib/new-note';

const NOW = new Date(2026, 9, 19, 14, 30);

function deps(over: Partial<NewNoteDeps> & { files?: Record<string, string> } = {}) {
  const files: Record<string, string> = { ...over.files };
  const created: string[] = [];
  const d: NewNoteDeps = {
    getSettings: async () => ({ dailyNotes: { enabled: true, folder: 'Journal', format: 'YYYY-MM-DD', template: 'Vorlagen/Tag.md' } }),
    readNote: async (p) => {
      if (!(p in files)) throw new ApiError(404, { error: 'nicht gefunden' });
      return files[p]!;
    },
    createNote: async (p, content) => {
      if (p in files) throw new ApiError(409, { error: 'exists' });
      files[p] = content;
      created.push(p);
      return { path: p };
    },
    exists: (p) => p in files,
    open: vi.fn(),
    refresh: vi.fn(),
    now: () => NOW,
    ...over,
  };
  return { d, files, created };
}

describe('newNotePath', () => {
  it('uses Unbenannt and numbers it while the name is taken', () => {
    const taken = new Set<string>();
    expect(newNotePath('', '', (p) => taken.has(p))).toBe('Unbenannt.md');
    taken.add('Unbenannt.md');
    expect(newNotePath('', '  ', (p) => taken.has(p))).toBe('Unbenannt 1.md');
    taken.add('Unbenannt 1.md');
    expect(newNotePath('Ordner/Unter', '', (p) => taken.has(p.replace('Ordner/Unter/', '')))).toBe('Ordner/Unter/Unbenannt 2.md');
  });

  it('numbers a chosen title and trims it', () => {
    expect(newNotePath('A', '  Plan ', (p) => p.toLowerCase() === 'a/plan.md')).toBe('A/Plan 1.md');
    expect(newNotePath('A', 'Plan', () => false)).toBe('A/Plan.md');
  });

  it.each(['a\\b', 'a/b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a#b', 'a^b', 'a[b', 'a]b', '.versteckt'])(
    'rejects %s',
    (title) => {
      expect(() => newNotePath('', title, () => false)).toThrow(InvalidNoteNameError);
    },
  );
});

describe('createFromTemplate', () => {
  it('fills the template with title and date and creates the note in the folder', async () => {
    const { d, created, files } = deps({ files: { 'Vorlagen/Notiz.md': '# {{title}}\n{{date}}' } });
    const path = await createFromTemplate('Vorlagen/Notiz.md', 'Projekte', 'Plan', d);
    expect(path).toBe('Projekte/Plan.md');
    expect(created).toEqual(['Projekte/Plan.md']);
    expect(files['Projekte/Plan.md']).toBe('# Plan\n2026-10-19');
  });

  it('takes the next free name when the creation races with another (409)', async () => {
    const { d, files, created } = deps({ files: { 'V/T.md': '{{title}}' } });
    d.exists = () => false; // the lookup does not know the note yet
    files['Plan.md'] = 'fremd';
    const path = await createFromTemplate('V/T.md', '', 'Plan', d);
    expect(path).toBe('Plan 1.md');
    expect(files['Plan.md']).toBe('fremd');
    expect(created).toEqual(['Plan 1.md']);
  });

  it('rejects an invalid title before touching the server', async () => {
    const { d } = deps({ files: { 'V/T.md': '' } });
    const read = vi.spyOn(d, 'readNote');
    await expect(createFromTemplate('V/T.md', '', 'a/b', d)).rejects.toBeInstanceOf(InvalidNoteNameError);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('openDailyNote', () => {
  it('creates Journal/2026-10-19.md with the template content and opens it', async () => {
    const { d, files } = deps({ files: { 'Vorlagen/Tag.md': '# {{date:DD.MM.YYYY}}\n\n{{title}}' } });
    const r = await openDailyNote(d);
    expect(r).toEqual({ status: 'opened', path: 'Journal/2026-10-19.md', created: true });
    expect(files['Journal/2026-10-19.md']).toBe('# 19.10.2026\n\n2026-10-19');
    expect(d.open).toHaveBeenCalledWith('Journal/2026-10-19.md');
    expect(d.refresh).toHaveBeenCalled();
  });

  it('opens an existing note without overwriting it (no template read, no create)', async () => {
    const { d, files, created } = deps({ files: { 'Journal/2026-10-19.md': 'mein Text', 'Vorlagen/Tag.md': 'X' } });
    const create = vi.spyOn(d, 'createNote');
    const r = await openDailyNote(d);
    expect(r).toEqual({ status: 'opened', path: 'Journal/2026-10-19.md', created: false });
    expect(create).not.toHaveBeenCalled();
    expect(created).toEqual([]);
    expect(files['Journal/2026-10-19.md']).toBe('mein Text');
    expect(d.open).toHaveBeenCalledWith('Journal/2026-10-19.md');
  });

  it('opens the existing note when the create loses a race (409), never overwrites', async () => {
    const { d, files } = deps({ files: { 'Vorlagen/Tag.md': 'X' } });
    d.exists = () => false;
    d.createNote = async () => {
      files['Journal/2026-10-19.md'] = 'schneller';
      throw new ApiError(409, { error: 'exists' });
    };
    const r = await openDailyNote(d);
    expect(r).toEqual({ status: 'opened', path: 'Journal/2026-10-19.md', created: false });
    expect(files['Journal/2026-10-19.md']).toBe('schneller');
    expect(d.open).toHaveBeenCalledWith('Journal/2026-10-19.md');
  });

  it('creates an empty note when no template is set or the template is gone', async () => {
    const none = deps({ getSettings: async () => ({ dailyNotes: { enabled: true, folder: '', format: 'YYYY/MM-DD', template: '' } }) });
    expect(await openDailyNote(none.d)).toMatchObject({ path: '2026/10-19.md', created: true });
    expect(none.files['2026/10-19.md']).toBe('');
    const gone = deps();
    expect(await openDailyNote(gone.d)).toMatchObject({ created: true });
    expect(gone.files['Journal/2026-10-19.md']).toBe('');
  });

  it('does nothing but report when daily notes are disabled', async () => {
    const { d, created } = deps({ getSettings: async () => ({ dailyNotes: { enabled: false, folder: '', format: 'YYYY-MM-DD', template: '' } }) });
    expect(await openDailyNote(d)).toEqual({ status: 'disabled' });
    expect(created).toEqual([]);
    expect(d.open).not.toHaveBeenCalled();
  });
});
