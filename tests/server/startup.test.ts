import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkVaultDir } from '../../server/vault/startup';

let base: string;
beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), 'vw-start-')));
});
afterEach(async () => {
  await chmod(path.join(base, 'ro'), 0o755).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

describe('checkVaultDir', () => {
  it('accepts a readable and writable directory', async () => {
    await expect(checkVaultDir(base)).resolves.toBeUndefined();
  });
  it('refuses a missing directory', async () => {
    await expect(checkVaultDir(path.join(base, 'fehlt'))).rejects.toThrow(/ist nicht erreichbar \(ENOENT\).*is not accessible/);
  });
  it('refuses a file', async () => {
    await writeFile(path.join(base, 'datei'), 'x');
    await expect(checkVaultDir(path.join(base, 'datei'))).rejects.toThrow(/ist kein Ordner/);
  });
  it.skipIf(process.getuid?.() === 0)('refuses a directory the process cannot write', async () => {
    await mkdir(path.join(base, 'ro'));
    await chmod(path.join(base, 'ro'), 0o555);
    await expect(checkVaultDir(path.join(base, 'ro'))).rejects.toThrow(/nicht les- und schreibbar.*PUID\/PGID/);
  });
});
