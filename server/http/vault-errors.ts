import type { FastifyInstance } from 'fastify';
import { ConflictError, NotAFileError, NotUtf8Error } from '../vault/files';
import { TargetExistsError } from '../vault/ops';
import { PathError } from '../vault/paths';
import { HttpError } from './guards';

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [404, 'Nicht gefunden'],
  ENOTDIR: [400, 'Ein Teil des Pfads ist kein Ordner'],
  EISDIR: [400, 'Pfad ist ein Ordner'],
  EEXIST: [409, 'Existiert bereits'],
  ENOTEMPTY: [409, 'Existiert bereits'],
  ENAMETOOLONG: [400, 'Name zu lang'],
  EACCES: [403, 'Zugriff verweigert'],
  EPERM: [403, 'Zugriff verweigert'],
};

/**
 * Maps errors of the vault modules to HTTP errors with fixed German messages (never the original
 * message: Node's fs errors contain absolute server paths). Undefined for anything else.
 * Hidden and excluded paths answer 404 so their existence is not revealed.
 */
export function vaultHttpError(err: unknown): HttpError | undefined {
  if (err instanceof PathError) {
    switch (err.code) {
      case 'OUTSIDE':
        return new HttpError(400, 'Ungültiger Pfad');
      case 'READONLY':
        return new HttpError(403, 'Pfad ist schreibgeschützt');
      default:
        return new HttpError(404, 'Nicht gefunden');
    }
  }
  if (err instanceof NotUtf8Error) {
    return new HttpError(
      415,
      'Die Datei ist nicht UTF-8-kodiert und kann hier nicht bearbeitet werden (sonst würden Zeichen zerstört). Als Anhang herunterladen geht weiterhin.',
    );
  }
  if (err instanceof NotAFileError) return new HttpError(400, 'Pfad ist keine Datei');
  if (err instanceof TargetExistsError) return new HttpError(409, 'Ziel existiert bereits');
  if (err instanceof ConflictError) return new HttpError(409, 'Konflikt: Datei wurde zwischenzeitlich geändert');
  const code = (err as NodeJS.ErrnoException | null)?.code;
  const hit = typeof code === 'string' && Object.hasOwn(ERRNO, code) ? ERRNO[code] : undefined;
  return hit ? new HttpError(hit[0], hit[1]) : undefined;
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
