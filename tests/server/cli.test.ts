import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { runCli, setupLink, terminalPrompt, type CliDeps } from '../../server/cli';
import { SessionStore } from '../../server/auth/sessions';
import { SetupTokens } from '../../server/auth/setup-token';

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'vw-cli-'));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

interface Harness {
  deps: CliDeps;
  out: string[];
  err: string[];
  prompts: string[];
  passkeys: { count: number };
  served: { count: number };
}

async function harness(opts: { publicUrl?: string; passkeys?: number; answer?: string } = {}): Promise<Harness> {
  const out: string[] = [];
  const err: string[] = [];
  const prompts: string[] = [];
  const passkeys = { count: opts.passkeys ?? 0 };
  const served = { count: 0 };
  const deps: CliDeps = {
    publicUrl: new URL(opts.publicUrl ?? 'https://vault.example.org'),
    setupTokens: await SetupTokens.open({ dataDir }),
    sessions: await SessionStore.open({ dataDir, sessionDays: 14 }),
    passkeys: {
      hasPasskeys: async () => passkeys.count > 0,
      clearPasskeys: async () => {
        passkeys.count = 0;
      },
    },
    serve: async () => {
      served.count += 1;
    },
    prompt: async (q) => {
      prompts.push(q);
      return opts.answer ?? '';
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err, prompts, passkeys, served };
}

const LINK = /^Einrichtung: https:\/\/vault\.example\.org\/setup#([A-Za-z0-9_-]{43})$/;

describe('setupLink', () => {
  it('builds <PUBLIC_URL>/setup#<token> without a double slash', () => {
    expect(setupLink(new URL('https://a.example/'), 'T')).toBe('https://a.example/setup#T');
    expect(setupLink(new URL('https://a.example/vault/'), 'T')).toBe('https://a.example/vault/setup#T');
    expect(setupLink(new URL('https://a.example/vault'), 'T')).toBe('https://a.example/vault/setup#T');
  });
});

describe('runCli', () => {
  it('setup-link prints a link with the token in the # fragment that can be consumed', async () => {
    const h = await harness({ passkeys: 1 });
    expect(await runCli(['setup-link'], h.deps)).toBe(0);
    expect(h.out).toHaveLength(1);
    const token = LINK.exec(h.out[0]!)?.[1];
    expect(token).toBeDefined();
    expect(await h.deps.setupTokens.consume(token!)).toBe(true);
    expect(h.passkeys.count).toBe(1);
  });

  it('setup-link handles a PUBLIC_URL with trailing slash', async () => {
    const h = await harness({ publicUrl: 'https://vault.example.org/' });
    await runCli(['setup-link'], h.deps);
    expect(h.out[0]).toMatch(LINK);
  });

  it('serve prints the setup link when no passkey exists, then serves', async () => {
    const h = await harness({ passkeys: 0 });
    expect(await runCli(['serve'], h.deps)).toBe(0);
    expect(h.out[0]).toMatch(LINK);
    expect(h.served.count).toBe(1);
  });

  it('serve prints no link when passkeys exist', async () => {
    const h = await harness({ passkeys: 2 });
    await runCli(['serve'], h.deps);
    expect(h.out).toEqual([]);
    expect(await h.deps.setupTokens.active()).toBe(false);
    expect(h.served.count).toBe(1);
  });

  it('defaults to serve without a command', async () => {
    const h = await harness({ passkeys: 1 });
    await runCli([], h.deps);
    expect(h.served.count).toBe(1);
  });

  it('reset-passkeys with "ja" deletes passkeys and sessions and prints a link', async () => {
    const h = await harness({ passkeys: 3, answer: 'ja' });
    await h.deps.sessions.create({ userAgent: 'x', ip: '1' });
    expect(await runCli(['reset-passkeys'], h.deps)).toBe(0);
    expect(h.prompts).toEqual(['Alle Passkeys löschen? (ja/nein)']);
    expect(h.passkeys.count).toBe(0);
    expect(await h.deps.sessions.list()).toEqual([]);
    expect(h.out.at(-1)).toMatch(LINK);
  });

  it.each(['nein', '', 'Ja', 'ja ', 'j', 'yes'])('reset-passkeys with %j changes nothing', async (answer) => {
    const h = await harness({ passkeys: 3, answer });
    await h.deps.sessions.create({ userAgent: 'x', ip: '1' });
    expect(await runCli(['reset-passkeys'], h.deps)).toBe(1);
    expect(h.passkeys.count).toBe(3);
    expect(await h.deps.sessions.list()).toHaveLength(1);
    expect(await h.deps.setupTokens.active()).toBe(false);
    expect(h.out.join('\n')).not.toMatch(/setup#/);
  });

  it('rejects unknown commands with usage on stderr', async () => {
    const h = await harness();
    expect(await runCli(['bogus'], h.deps)).toBe(2);
    expect(h.err.join('\n')).toMatch(/serve \| setup-link \| reset-passkeys/);
    expect(h.served.count).toBe(0);
  });
});

describe('terminalPrompt', () => {
  it('returns the typed line without line break', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const answer = terminalPrompt('Frage?', input, output);
    input.write('ja\n');
    expect(await answer).toBe('ja');
    expect(output.read()?.toString()).toBe('Frage? ');
  });

  it('returns "" when stdin is closed without an answer', async () => {
    const input = new PassThrough();
    const answer = terminalPrompt('Frage?', input, new PassThrough());
    input.end();
    expect(await answer).toBe('');
  });

  it('reset-passkeys with closed stdin aborts with exit 1', async () => {
    const h = await harness({ passkeys: 1 });
    const input = new PassThrough();
    input.end();
    h.deps.prompt = (q) => terminalPrompt(q, input, new PassThrough());
    expect(await runCli(['reset-passkeys'], h.deps)).toBe(1);
    expect(h.passkeys.count).toBe(1);
    expect(h.out).toEqual(['Abgebrochen, nichts gelöscht.']);
  });
});
