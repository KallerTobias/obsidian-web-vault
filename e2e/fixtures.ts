import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type CDPSession, type Page } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_VAULT = join(ROOT, 'e2e', 'fixture-vault');
const SERVER_JS = join(ROOT, 'dist', 'server.js');

/** A WebAuthn credential as the CDP `WebAuthn` domain hands it out (incl. private key). */
type Credential = Record<string, unknown> & { credentialId: string };

/** One app server (built bundle) on a temporary copy of the fixture vault with an empty DATA_DIR. */
export class AppServer {
  /** Cookies of a logged-in browser plus the passkey, set up on first use of `authed`. */
  auth: { cookies: Awaited<ReturnType<BrowserContext['cookies']>>; credential: Credential } | null = null;
  private output = '';

  private constructor(
    readonly url: string,
    readonly vaultDir: string,
    readonly dataDir: string,
    readonly setupLink: string,
    private readonly child: ChildProcess,
    private readonly tmp: string,
  ) {}

  static async start(): Promise<AppServer> {
    const tmp = await mkdtemp(join(tmpdir(), 'obsidian-web-vault-e2e-'));
    const vaultDir = join(tmp, 'vault');
    const dataDir = join(tmp, 'data');
    await cp(FIXTURE_VAULT, vaultDir, { recursive: true });
    await mkdir(dataDir);
    const port = await freePort();
    const url = `http://localhost:${port}`;
    const child = spawn(process.execPath, [SERVER_JS], {
      cwd: ROOT,
      env: { ...process.env, PUBLIC_URL: url, HOST: '127.0.0.1', PORT: String(port), VAULT_DIR: vaultDir, DATA_DIR: dataDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const setupLink = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server startete nicht:\n${output}`)), 20_000);
      let link = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        link ||= /Einrichtung: (\S+)/.exec(output)?.[1] ?? '';
        if (link && output.includes('Server listening')) {
          clearTimeout(timer);
          resolve(link);
        }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server beendet (${code}):\n${output}`));
      });
    });
    const server = new AppServer(url, vaultDir, dataDir, setupLink, child, tmp);
    server.output = output;
    child.stdout!.on('data', (c: Buffer) => (server.output += c.toString()));
    child.stderr!.on('data', (c: Buffer) => (server.output += c.toString()));
    return server;
  }

  /** Server log so far (attached to failed tests). */
  get log(): string {
    return this.output;
  }

  /** Last resort when the worker exits without teardown. */
  killNow(): void {
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
  }

  /** Reads a vault file (path relative to the vault, as on disk). */
  read(rel: string): Promise<string> {
    return readFile(join(this.vaultDir, rel), 'utf8');
  }

  readBytes(rel: string): Promise<Buffer> {
    return readFile(join(this.vaultDir, rel));
  }

  /** Writes a vault file directly on disk, like Obsidian or Syncthing would. */
  write(rel: string, content: string): Promise<void> {
    return writeFile(join(this.vaultDir, rel), content);
  }

  /** Names in a vault folder ('' = root), dotfiles included. */
  list(rel = ''): Promise<string[]> {
    return readdir(join(this.vaultDir, rel)).catch(() => []);
  }

  async stop(): Promise<void> {
    if (this.child.exitCode === null) {
      const exited = new Promise((r) => this.child.once('exit', r));
      this.child.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      if (this.child.exitCode === null) this.child.kill('SIGKILL');
    }
    await rm(this.tmp, { recursive: true, force: true });
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

// One server per test file: tests of a file run in order in one worker process.
let current: { file: string; server: AppServer } | null = null;

async function serverFor(file: string): Promise<AppServer> {
  if (current?.file === file) return current.server;
  if (current) await current.server.stop();
  current = null;
  current = { file, server: await AppServer.start() };
  return current.server;
}

const AUTHENTICATOR = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
} as const;

/** A virtual platform authenticator (CDP) for `page`, optionally holding an existing credential. */
export async function addAuthenticator(
  page: Page,
  credential?: Credential,
): Promise<{ cdp: CDPSession; authenticatorId: string; credentials(): Promise<Credential[]> }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR });
  if (credential) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: credential as never });
  return {
    cdp,
    authenticatorId,
    credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials as unknown as Credential[],
  };
}

type Authenticator = Awaited<ReturnType<typeof addAuthenticator>>;
const authenticators = new WeakMap<Page, Authenticator>();

/** The virtual authenticator the `authed` fixture gave `page`. */
export function authenticatorOf(page: Page): Authenticator {
  const a = authenticators.get(page);
  if (!a) throw new Error('Seite ohne virtuellen Authenticator');
  return a;
}

/** The app shell is shown (logged in, tree loaded). */
export async function expectApp(page: Page): Promise<void> {
  await expect(page.getByRole('tree', { name: 'Dateien im Vault' })).toBeVisible();
}

/** Opens `path` as the only tab (workspace state in localStorage, then a reload) and waits for the editor. */
export async function openNote(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    localStorage.setItem('vw.workspace', JSON.stringify({ tabs: [{ kind: 'note', path: p, history: [p], pos: 0 }], active: 0, recent: [] }));
  }, path);
  await page.reload();
  await expect(page.locator('.note-view .cm-content')).toBeVisible();
  await expect(page.locator('.save-state')).toHaveText('Gespeichert');
}

/** The editor's text lines (as rendered: hidden markup is missing). */
export const editorLines = (page: Page) => page.locator('.note-view .cm-content .cm-line');

/** CSP violations and uncaught errors seen by a page (checked after every test). */
export interface PageProblems {
  csp: string[];
  errors: string[];
  dialogs: string[];
}

interface Fixtures {
  server: AppServer;
  problems: PageProblems;
  /** A page logged in with a passkey (virtual authenticator) and showing the app. */
  authed: Page;
}

export const test = base.extend<Fixtures, { serverCleanup: void }>({
  /** Stops the last file's server when the worker ends. */
  serverCleanup: [
    async ({}, use) => {
      await use();
      if (current) await current.server.stop();
      current = null;
    },
    { scope: 'worker', auto: true },
  ],

  server: async ({}, use, testInfo) => {
    const server = await serverFor(testInfo.file);
    await use(server);
    if (testInfo.status !== testInfo.expectedStatus) await testInfo.attach('server.log', { body: server.log, contentType: 'text/plain' });
  },

  // Every test that uses a page: CSP violations and uncaught browser errors fail it.
  problems: [
    async ({ page }, use) => {
      const problems: PageProblems = { csp: [], errors: [], dialogs: [] };
      await page.exposeBinding('__vwCspViolation', (_src, text: string) => void problems.csp.push(text));
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          (window as unknown as { __vwCspViolation(t: string): void }).__vwCspViolation(
            `${e.violatedDirective} blocked ${e.blockedURI || '(inline/eval)'} at ${e.sourceFile}:${e.lineNumber}`,
          );
        });
      });
      page.on('console', (msg) => {
        if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) problems.csp.push(msg.text());
      });
      page.on('pageerror', (err) => problems.errors.push(String(err)));
      await use(problems);
      // Violation events are queued as tasks: let the page run them before checking.
      await page.evaluate(() => new Promise((r) => setTimeout(r))).catch(() => {});
      expect(problems.csp, 'CSP-Verstöße').toEqual([]);
      expect(problems.errors, 'Unbehandelte Fehler im Browser').toEqual([]);
    },
    { auto: true },
  ],

  authed: async ({ page, server }, use) => {
    const context = page.context();
    if (!server.auth) {
      // First authed test of this file: set up the first passkey with the setup link.
      const authn = await addAuthenticator(page);
      authenticators.set(page, authn);
      await page.goto(server.setupLink);
      await page.getByRole('button', { name: 'Passkey anlegen' }).click();
      await expectApp(page);
      const [credential] = await authn.credentials();
      server.auth = { cookies: await context.cookies(), credential: credential! };
    } else {
      authenticators.set(page, await addAuthenticator(page, server.auth.credential));
      await context.addCookies(server.auth.cookies);
      await page.goto(server.url);
      // An earlier test may have ended the session (logout): the login screen's passkey autofill
      // (conditional UI, answered by the virtual authenticator) logs in again on its own.
      await expectApp(page);
      server.auth.cookies = await context.cookies();
    }
    await use(page);
  },
});

process.once('exit', () => {
  // Worker shutting down without fixture teardown: do not leave the server running.
  current?.server.killNow();
});

export { expect };
