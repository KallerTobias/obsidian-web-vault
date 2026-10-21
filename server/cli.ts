import { createInterface } from 'node:readline';
import type { SessionStore } from './auth/sessions';
import type { SetupTokens } from './auth/setup-token';

/** What the CLI needs from the passkey storage (provided by the WebAuthn module). */
export interface PasskeyAdmin {
  hasPasskeys(): Promise<boolean>;
  clearPasskeys(): Promise<void>;
}

export interface CliDeps {
  publicUrl: URL;
  setupTokens: SetupTokens;
  sessions: SessionStore;
  passkeys: PasskeyAdmin;
  /** Starts the HTTP server; resolves once it is listening. */
  serve(): Promise<void>;
  /** Asks a question on the terminal and returns the answer line (without line break). */
  prompt(question: string): Promise<string>;
  out(line: string): void;
  err(line: string): void;
}

/**
 * Asks on the terminal. Resolves with the answer line, or `''` when the input closes
 * without an answer (e.g. `docker exec` without `-i`), which callers treat as "no".
 */
export function terminalPrompt(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: false });
    let answered = false;
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) resolve('');
    });
    output.write(`${question} `);
  });
}

const USAGE = 'Aufruf: node dist/server.js [serve | setup-link | reset-passkeys]';

/** `<PUBLIC_URL>/setup#<token>` – the token sits in the fragment so it never reaches server logs. */
export function setupLink(publicUrl: URL, token: string): string {
  return `${publicUrl.origin}${publicUrl.pathname.replace(/\/+$/, '')}/setup#${token}`;
}

async function printNewSetupLink(deps: CliDeps): Promise<void> {
  const token = await deps.setupTokens.issue();
  deps.out(`Einrichtung: ${setupLink(deps.publicUrl, token)}`);
}

/** Runs a CLI command and returns the exit code. Without a command, `serve` runs. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command = 'serve', ...rest] = argv;
  if (rest.length > 0) {
    deps.err(USAGE);
    return 2;
  }
  switch (command) {
    case 'serve':
      if (!(await deps.passkeys.hasPasskeys())) await printNewSetupLink(deps);
      await deps.serve();
      return 0;
    case 'setup-link':
      await printNewSetupLink(deps);
      return 0;
    case 'reset-passkeys': {
      const answer = await deps.prompt('Alle Passkeys löschen? (ja/nein)');
      if (answer !== 'ja') {
        deps.out('Abgebrochen, nichts gelöscht.');
        return 1;
      }
      await deps.passkeys.clearPasskeys();
      await deps.sessions.revokeAll();
      deps.out('Alle Passkeys und Sitzungen gelöscht.');
      await printNewSetupLink(deps);
      return 0;
    }
    default:
      deps.err(USAGE);
      return 2;
  }
}
