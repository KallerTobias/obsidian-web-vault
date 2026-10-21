import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';

/**
 * Checks before the watcher starts that VAULT_DIR exists, is a directory and is readable and
 * writable by this process. Throws an Error with a clear message (German and English), so a
 * wrong mount or PUID ends the process with a non-zero exit code instead of hanging silently.
 */
export async function checkVaultDir(dir: string): Promise<void> {
  const ids = `uid ${process.getuid?.() ?? '?'}, gid ${process.getgid?.() ?? '?'}`;
  let st;
  try {
    st = await stat(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'unbekannt';
    throw new Error(
      `VAULT_DIR "${dir}" ist nicht erreichbar (${code}) – Mount prüfen. / VAULT_DIR "${dir}" is not accessible (${code}) – check the mount.`,
    );
  }
  if (!st.isDirectory()) {
    throw new Error(`VAULT_DIR "${dir}" ist kein Ordner. / VAULT_DIR "${dir}" is not a directory.`);
  }
  try {
    await access(dir, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(
      `VAULT_DIR "${dir}" ist für den Prozess (${ids}) nicht les- und schreibbar – PUID/PGID prüfen. / ` +
        `VAULT_DIR "${dir}" is not readable and writable by the process (${ids}) – check PUID/PGID.`,
    );
  }
}
