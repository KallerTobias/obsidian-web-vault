import type { FastifyInstance } from 'fastify';
import { ConflictError, NotAFileError, NotUtf8Error } from '../vault/files';
import { TargetExistsError } from '../vault/ops';
import { PathError } from '../vault/paths';
import { HttpError } from './guards';

const ERRNO: Record<string, [number, string, string]> = {
  ENOENT: [404, 'Nicht gefunden', 'NOT_FOUND'],
  ENOTDIR: [400, 'Ein Teil des Pfads ist kein Ordner', 'NOT_A_FOLDER'],
  EISDIR: [400, 'Pfad ist ein Ordner', 'IS_A_FOLDER'],
  EEXIST: [409, 'Existiert bereits', 'EXISTS'],
  ENOTEMPTY: [409, 'Existiert bereits', 'EXISTS'],
  ENAMETOOLONG: [400, 'Name zu lang', 'NAME_TOO_LONG'],
  EACCES: [403, 'Zugriff verweigert', 'ACCESS_DENIED'],
  EPERM: [403, 'Zugriff verweigert', 'ACCESS_DENIED'],
};

/**
 * Maps errors of the vault modules to HTTP errors with fixed German messages (never the original
 * message: Node's fs errors contain absolute server paths). Undefined for anything else.
 * Hidden and excluded paths answer 404 `NOT_FOUND` so their existence is not revealed (no own code).
 */
export function vaultHttpError(err: unknown): HttpError | undefined {
  if (err instanceof PathError) {
    switch (err.code) {
      case 'OUTSIDE':
        return new HttpError(400, 'Ungültiger Pfad', 'INVALID_PATH');
      case 'READONLY':
        return new HttpError(403, 'Pfad ist schreibgeschützt', 'READONLY');
      default:
        return new HttpError(404, 'Nicht gefunden', 'NOT_FOUND');
    }
  }
  if (err instanceof NotUtf8Error) {
    return new HttpError(
      415,
      'Die Datei ist nicht UTF-8-kodiert und kann hier nicht bearbeitet werden (sonst würden Zeichen zerstört). Als Anhang herunterladen geht weiterhin.',
      'NOT_UTF8',
    );
  }
  if (err instanceof NotAFileError) return new HttpError(400, 'Pfad ist keine Datei', 'NOT_A_FILE');
  if (err instanceof TargetExistsError) return new HttpError(409, 'Ziel existiert bereits', 'TARGET_EXISTS');
  if (err instanceof ConflictError) return new HttpError(409, 'Konflikt: Datei wurde zwischenzeitlich geändert', 'CONFLICT');
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const hit = typeof code === 'string' && Object.hasOwn(ERRNO, code) ? ERRNO[code] : undefined;
  return hit ? new HttpError(hit[0], hit[1], hit[2]) : undefined;
}

/**
 * Error handler for the vault route plugins: vault errors become HttpErrors, everything else is
 * passed on unchanged to the app's handler (so errors of the DATA_DIR stores stay a logged 500).
 * Errno codes are only mapped here, where they come from vault file system operations.
 */
export function mapVaultErrors(app: FastifyInstance): void {
  app.setErrorHandler((err) => {
    throw vaultHttpError(err) ?? err;
  });
}
