import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { PasskeyAdmin } from '../cli';
import { JsonStore } from '../store/json-store';

export interface Passkey {
  /** Credential ID (base64url). */
  id: string;
  name: string;
  /** COSE public key (base64url). */
  publicKey: string;
  counter: number;
  transports: string[];
  createdAt: number;
  lastUsed: number | null;
}

/** A credential as the verifier needs it. */
export interface StoredCredential {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

interface Expected {
  /** Untrusted client response (JSON from the browser). */
  response: unknown;
  expectedChallenge: string;
  expectedOrigin: string;
  expectedRPID: string;
  /** The authenticator must have verified the user (PIN, biometrics); always true in production. */
  requireUserVerification: boolean;
}

/**
 * Cryptographic WebAuthn verification. Returns `null` (or throws) when the response does not verify.
 * Production: SimpleWebAuthn (`simpleWebAuthnVerifier`); tests inject a fake.
 */
export interface WebAuthnVerifier {
  verifyRegistration(args: Expected): Promise<StoredCredential | null>;
  verifyAuthentication(args: Expected & { credential: StoredCredential }): Promise<{ newCounter: number } | null>;
}

const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

export const simpleWebAuthnVerifier: WebAuthnVerifier = {
  async verifyRegistration({ response, expectedChallenge, expectedOrigin, expectedRPID, requireUserVerification }) {
    const r = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification,
    });
    if (!r.verified) return null;
    const c = r.registrationInfo.credential;
    return { id: c.id, publicKey: b64url(c.publicKey), counter: c.counter, transports: c.transports ?? [] };
  },
  async verifyAuthentication({ response, expectedChallenge, expectedOrigin, expectedRPID, requireUserVerification, credential }) {
    const r = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge,
      expectedOrigin,
      expectedRPID,
      requireUserVerification,
      credential: {
        id: credential.id,
        publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
        counter: credential.counter,
        transports: credential.transports as AuthenticatorTransportFuture[],
      },
    });
    return r.verified ? { newCounter: r.authenticationInfo.newCounter } : null;
  },
};

export type PasskeyErrorCode = 'CHALLENGE' | 'VERIFY' | 'FORBIDDEN' | 'DUPLICATE' | 'NOT_FOUND' | 'LAST_PASSKEY' | 'STEP_UP';

export class PasskeyError extends Error {
  constructor(
    readonly code: PasskeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

interface PasskeysFile {
  /** WebAuthn user handle of the single user (32 random bytes, base64url), created once. */
  userId: string | null;
  passkeys: Passkey[];
}

/** `confirmation`: re-authentication with an existing passkey before adding another one. */
type CeremonyKind = 'registration' | 'authentication' | 'confirmation';

/** Challenges live this long. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/**
 * Open challenges per client (rate-limit key, i.e. IP): its own oldest is dropped first, so one
 * client cannot push out the challenge of another (the owner's login).
 */
const MAX_CHALLENGES_PER_CLIENT = 20;
/** Memory backstop over all clients (oldest dropped first). */
const MAX_CHALLENGES = 10_000;
/** A confirmation with an existing passkey allows adding one passkey within this time. */
const STEP_UP_TTL_MS = 5 * 60 * 1000;
/** Every ceremony requires user verification (PIN, biometrics), not only presence. */
const USER_VERIFICATION = 'required';
const USER_NAME = 'vault';
const RP_NAME = 'Vault';
const MAX_NAME = 100;

export interface PasskeyServiceOptions {
  dataDir: string;
  rpId: string;
  /** Expected origin, e.g. `https://vault.example.com`. */
  origin: string;
  verifier?: WebAuthnVerifier;
  now?: () => number;
}

export interface CeremonyOptions<T> {
  options: T;
  /** Sent back by the client with the response; identifies the server-side challenge. */
  challengeId: string;
}

const cleanName = (name: unknown): string => {
  const n = typeof name === 'string' ? name.trim().slice(0, MAX_NAME) : '';
  return n === '' ? 'Passkey' : n;
};

/**
 * Passkeys of the single user in `<dataDir>/passkeys.json`, plus the in-memory WebAuthn challenges
 * (5 min, single use). Every public method first picks up changes by another process (CLI).
 */
export class PasskeyService implements PasskeyAdmin {
  private readonly store: JsonStore<PasskeysFile>;
  private readonly verifier: WebAuthnVerifier;
  private readonly now: () => number;
  private readonly challenges = new Map<
    string,
    { challenge: string; kind: CeremonyKind; expires: number; client: string; session?: string }
  >();
  /** Session id → expiry of a successful confirmation (single use, see `addOptions`). */
  private readonly stepUps = new Map<string, number>();

  private constructor(private readonly opts: PasskeyServiceOptions) {
    this.store = new JsonStore<PasskeysFile>(join(opts.dataDir, 'passkeys.json'), { userId: null, passkeys: [] });
    this.verifier = opts.verifier ?? simpleWebAuthnVerifier;
    this.now = opts.now ?? Date.now;
  }

  static async open(opts: PasskeyServiceOptions): Promise<PasskeyService> {
    const s = new PasskeyService(opts);
    await s.store.load();
    return s;
  }

  private async current(): Promise<PasskeysFile> {
    await this.store.refresh();
    const f = this.store.get();
    if (!Array.isArray(f.passkeys)) {
      throw new Error('passkeys.json hat ein unerwartetes Format (passkeys ist keine Liste)');
    }
    return f;
  }

  async list(): Promise<Passkey[]> {
    return (await this.current()).passkeys;
  }

  async hasPasskeys(): Promise<boolean> {
    return (await this.current()).passkeys.length > 0;
  }

  async clearPasskeys(): Promise<void> {
    await this.store.update((f) => {
      f.passkeys = [];
    });
  }

  /**
   * Registration options for the setup (first passkey or CLI setup link). `client` is the
   * rate-limit key of the requester (bounds its open challenges).
   */
  async registrationOptions(client = ''): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    return this.newRegistration(client);
  }

  private async newRegistration(
    client: string,
    session?: string,
  ): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    let { userId, passkeys } = await this.current();
    if (!userId) {
      const fresh = randomBytes(32).toString('base64url');
      // Another writer may have created one meanwhile; keep the first.
      userId = (
        await this.store.update((f) => {
          f.userId ??= fresh;
        })
      ).userId!;
    }
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.opts.rpId,
      userName: USER_NAME,
      userID: new Uint8Array(Buffer.from(userId, 'base64url')),
      attestationType: 'none',
      excludeCredentials: passkeys.map((p) => ({
        id: p.id,
        transports: p.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: USER_VERIFICATION },
    });
    return { options, challengeId: this.remember(options.challenge, 'registration', client, session) };
  }

  /**
   * Step-up before adding a passkey: authentication options bound to the session. Only after
   * `finishConfirmation` succeeded may `addOptions` issue registration options.
   */
  async confirmationOptions(session: string, client = ''): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    await this.store.refresh();
    const options = await generateAuthenticationOptions({ rpID: this.opts.rpId, userVerification: USER_VERIFICATION });
    return { options, challengeId: this.remember(options.challenge, 'confirmation', client, session) };
  }

  /** Verifies the confirmation with an existing passkey; on success the session may add one passkey for 5 min. */
  async finishConfirmation(session: string, challengeId: string, response: unknown): Promise<boolean> {
    await this.store.refresh();
    const challenge = this.take(challengeId, 'confirmation', session);
    if (!(await this.verifyAssertion(challenge, response))) return false;
    this.stepUps.set(session, this.now() + STEP_UP_TTL_MS);
    return true;
  }

  /**
   * Registration options for adding a passkey in a session. Needs a fresh confirmation of the same
   * session (consumed here: one confirmation, one new passkey); otherwise STEP_UP.
   */
  async addOptions(session: string, client = ''): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    const until = this.stepUps.get(session);
    this.stepUps.delete(session);
    for (const [k, v] of this.stepUps) if (v <= this.now()) this.stepUps.delete(k);
    if (until === undefined || until <= this.now()) {
      throw new PasskeyError('STEP_UP', 'Bitte zuerst mit einem vorhandenen Passkey bestätigen');
    }
    return this.newRegistration(client, session);
  }

  /**
   * Verifies a registration and stores the passkey. `authorize` runs after successful
   * verification and before saving (e.g. redeeming the setup token); `false` → FORBIDDEN.
   */
  async finishRegistration(
    challengeId: string,
    response: unknown,
    name: string,
    authorize?: () => Promise<boolean>,
    /** Session the options were issued to by `addOptions` (undefined: setup). */
    session?: string,
  ): Promise<Passkey> {
    await this.store.refresh();
    const challenge = this.take(challengeId, 'registration', session);
    let cred: StoredCredential | null;
    try {
      cred = await this.verifier.verifyRegistration({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.opts.origin,
        expectedRPID: this.opts.rpId,
        requireUserVerification: true,
      });
    } catch {
      cred = null;
    }
    if (!cred) throw new PasskeyError('VERIFY', 'Passkey konnte nicht bestätigt werden');
    if ((await this.current()).passkeys.some((p) => p.id === cred.id)) {
      throw new PasskeyError('DUPLICATE', 'Dieser Passkey ist bereits registriert');
    }
    if (authorize && !(await authorize())) {
      throw new PasskeyError('FORBIDDEN', 'Einrichtungslink ungültig oder abgelaufen');
    }
    const passkey: Passkey = {
      id: cred.id,
      name: cleanName(name),
      publicKey: cred.publicKey,
      counter: cred.counter,
      transports: cred.transports,
      createdAt: this.now(),
      lastUsed: null,
    };
    let duplicate = false;
    await this.store.update((f) => {
      if (f.passkeys.some((p) => p.id === passkey.id)) {
        duplicate = true;
        return;
      }
      f.passkeys.push(passkey);
    });
    if (duplicate) throw new PasskeyError('DUPLICATE', 'Dieser Passkey ist bereits registriert');
    return passkey;
  }

  async authenticationOptions(client = ''): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    await this.store.refresh();
    // Discoverable credentials: no allowCredentials, the authenticator offers the passkey.
    const options = await generateAuthenticationOptions({ rpID: this.opts.rpId, userVerification: USER_VERIFICATION });
    return { options, challengeId: this.remember(options.challenge, 'authentication', client) };
  }

  /** `true` when the assertion verifies for a stored passkey; updates counter and lastUsed. */
  async finishAuthentication(challengeId: string, response: unknown): Promise<boolean> {
    await this.store.refresh();
    const challenge = this.take(challengeId, 'authentication');
    return this.verifyAssertion(challenge, response);
  }

  /** Verifies an assertion (user verification required) against the stored passkeys; updates counter and lastUsed. */
  private async verifyAssertion(challenge: string, response: unknown): Promise<boolean> {
    const id = (response as { id?: unknown } | null)?.id;
    if (typeof id !== 'string') return false;
    const passkey = (await this.current()).passkeys.find((p) => p.id === id);
    if (!passkey) return false;
    let result: { newCounter: number } | null;
    try {
      result = await this.verifier.verifyAuthentication({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.opts.origin,
        expectedRPID: this.opts.rpId,
        requireUserVerification: true,
        credential: passkey,
      });
    } catch {
      result = null;
    }
    if (!result) return false;
    let stillThere = false;
    const usedAt = this.now();
    await this.store.update((f) => {
      const p = f.passkeys.find((x) => x.id === id);
      if (!p) return;
      stillThere = true;
      p.counter = result.newCounter;
      p.lastUsed = usedAt;
    });
    return stillThere;
  }

  /** Removes a passkey. Removing the last one requires `force` (otherwise LAST_PASSKEY). */
  async remove(id: string, opts: { force?: boolean } = {}): Promise<void> {
    let error: PasskeyError | undefined;
    await this.store.update((f) => {
      if (!f.passkeys.some((p) => p.id === id)) {
        error = new PasskeyError('NOT_FOUND', 'Passkey nicht gefunden');
        return;
      }
      if (f.passkeys.length === 1 && !opts.force) {
        error = new PasskeyError('LAST_PASSKEY', 'Der letzte Passkey kann nur ausdrücklich gelöscht werden');
        return;
      }
      f.passkeys = f.passkeys.filter((p) => p.id !== id);
    });
    if (error) throw error;
  }

  async rename(id: string, name: string): Promise<void> {
    let found = false;
    await this.store.update((f) => {
      const p = f.passkeys.find((x) => x.id === id);
      if (!p) return;
      found = true;
      p.name = cleanName(name);
    });
    if (!found) throw new PasskeyError('NOT_FOUND', 'Passkey nicht gefunden');
  }

  private remember(challenge: string, kind: CeremonyKind, client: string, session?: string): string {
    const now = this.now();
    for (const [k, v] of this.challenges) if (v.expires <= now) this.challenges.delete(k);
    // Per client: drop its own oldest (Map keeps insertion order).
    const own = [...this.challenges].filter(([, v]) => v.client === client);
    for (let i = 0; i <= own.length - MAX_CHALLENGES_PER_CLIENT; i++) this.challenges.delete(own[i]![0]);
    while (this.challenges.size >= MAX_CHALLENGES) {
      const oldest = this.challenges.keys().next().value;
      if (oldest === undefined) break;
      this.challenges.delete(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    this.challenges.set(id, { challenge, kind, expires: now + CHALLENGE_TTL_MS, client, ...(session ? { session } : {}) });
    return id;
  }

  /**
   * Single use: the challenge is gone after this call, whatever the outcome. It must belong to
   * `session` (registration challenges from `addOptions` and confirmations) or to none (setup, login).
   */
  private take(challengeId: string, kind: CeremonyKind, session?: string): string {
    const c = typeof challengeId === 'string' ? this.challenges.get(challengeId) : undefined;
    if (c) this.challenges.delete(challengeId);
    if (!c || c.kind !== kind || c.session !== session || c.expires <= this.now()) {
      throw new PasskeyError('CHALLENGE', 'Anfrage abgelaufen oder ungültig, bitte erneut versuchen');
    }
    return c.challenge;
  }
}
