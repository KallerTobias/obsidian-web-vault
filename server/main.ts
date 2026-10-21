import { fileURLToPath } from 'node:url';
import { PasskeyService } from './auth/passkeys';
import { SessionStore } from './auth/sessions';
import { SetupTokens } from './auth/setup-token';
import { runCli, terminalPrompt } from './cli';
import { loadConfig, type Config } from './config';
import { EventBus } from './events';
import { buildApp } from './http/app';
import { SearchIndex } from './index/search';
import { VaultIndex } from './index/vault-index';
import { loadSettings } from './store/settings';
import { VaultFiles } from './vault/files';
import { VaultOps } from './vault/ops';
import { VaultPaths } from './vault/paths';
import { checkVaultDir } from './vault/startup';
import { VaultWatcher, type WatcherLog } from './vault/watcher';

/** Own temp files older than this are left over from a crash and removed at start. */
const ORPHAN_TEMP_AGE_MS = 60 * 60 * 1000;

/** Builds the vault modules and the HTTP app, listens, and shuts down cleanly on SIGTERM/SIGINT. */
async function serve(
  config: Config,
  auth: { sessions: SessionStore; setup: SetupTokens; passkeys: PasskeyService },
): Promise<void> {
  // A missing mount or wrong PUID must end the process with a clear message, not hang.
  await checkVaultDir(config.vaultDir);
  const paths = new VaultPaths(config.vaultDir, config.excludeGlobs, config.readonlyGlobs);
  const files = new VaultFiles(paths);
  const index = new VaultIndex();
  const search = new SearchIndex();
  const events = new EventBus();
  // The app (and its logger) is built below; the watcher only logs once started.
  const log: WatcherLog = {
    info: (obj, msg) => app.log.info(obj, msg),
    warn: (obj, msg) => app.log.warn(obj, msg),
    error: (obj, msg) => app.log.error(obj, msg),
  };
  const watcher = new VaultWatcher({ root: config.vaultDir, paths, files, index, search, bus: events, log });
  const ops = new VaultOps({ paths, files, index, bus: events, watcher });
  const settings = await loadSettings(config.dataDir, config.vaultDir);

  // Next to the bundle (`dist/server.js` → `dist/web`); absent under `tsx` in development, where Vite serves it.
  const webDir = fileURLToPath(new URL('./web', import.meta.url));
  const app = buildApp({ config, ...auth, paths, files, ops, index, search, events, settings, watcher }, { webDir });

  try {
    for (const p of await files.removeOrphanTemps(ORPHAN_TEMP_AGE_MS)) {
      app.log.warn({ path: p }, 'Verwaiste Temp-Datei entfernt');
    }
    await watcher.start();
  } catch (err) {
    await app.close();
    throw err;
  }

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} empfangen, beende`);
    // Deadline: connections that never become idle must not block the shutdown.
    setTimeout(() => app.server.closeAllConnections(), 5000).unref();
    Promise.allSettled([app.close(), watcher.stop()]).then(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    // The running watcher would keep the event loop alive and the process would hang.
    process.removeListener('SIGTERM', shutdown);
    process.removeListener('SIGINT', shutdown);
    await Promise.allSettled([app.close(), watcher.stop()]);
    throw err;
  }
}

async function main(): Promise<number> {
  const config = loadConfig(process.env);
  // Before anything creates files (sessions, setup token, vault writes).
  process.umask(config.umask);

  const sessions = await SessionStore.open({ dataDir: config.dataDir, sessionDays: config.sessionDays });
  const setupTokens = await SetupTokens.open({ dataDir: config.dataDir });
  const passkeys = await PasskeyService.open({
    dataDir: config.dataDir,
    rpId: config.rpId,
    origin: config.publicUrl.origin,
  });

  return runCli(process.argv.slice(2), {
    publicUrl: config.publicUrl,
    setupTokens,
    sessions,
    passkeys,
    serve: () => serve(config, { sessions, setup: setupTokens, passkeys }),
    prompt: (question) => terminalPrompt(question),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Fehler: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
