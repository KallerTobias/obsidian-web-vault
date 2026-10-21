import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { simpleWebAuthnVerifier } from '../../server/auth/passkeys';

/**
 * A real assertion (ES256) for SimpleWebAuthn: proves that the production verifier rejects a
 * response without the user-verified flag when `requireUserVerification` is true.
 */
const RP_ID = 'vault.example.com';
const ORIGIN = 'https://vault.example.com';
const b64u = (b: Buffer) => b.toString('base64url');

function credential() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y} in CBOR
  const cose = Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
  return { privateKey, cose };
}

function assertion(privateKey: ReturnType<typeof credential>['privateKey'], challenge: string, flags: number) {
  const authData = Buffer.concat([
    createHash('sha256').update(RP_ID).digest(),
    Buffer.from([flags]),
    Buffer.from([0, 0, 0, 1]), // sign counter
  ]);
  const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false }));
  const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientData).digest()]), privateKey);
  return {
    id: 'cred-1',
    rawId: 'cred-1',
    type: 'public-key',
    clientExtensionResults: {},
    response: { authenticatorData: b64u(authData), clientDataJSON: b64u(clientData), signature: b64u(signature) },
  };
}

describe('simpleWebAuthnVerifier: user verification', () => {
  const UP = 0x01;
  const UV = 0x04;
  const challenge = b64u(Buffer.from('challenge-0123456789abcdef'));

  async function verify(flags: number, requireUserVerification: boolean) {
    const { privateKey, cose } = credential();
    return simpleWebAuthnVerifier
      .verifyAuthentication({
        response: assertion(privateKey, challenge, flags),
        expectedChallenge: challenge,
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification,
        credential: { id: 'cred-1', publicKey: b64u(cose), counter: 0, transports: ['internal'] },
      })
      .catch(() => null);
  }

  it('accepts an assertion with user verification', async () => {
    expect(await verify(UP | UV, true)).toEqual({ newCounter: 1 });
  });

  it('rejects an assertion with only user presence when verification is required', async () => {
    expect(await verify(UP, true)).toBeNull();
  });

  it('(control) the same assertion passes when verification is not required', async () => {
    expect(await verify(UP, false)).toEqual({ newCounter: 1 });
  });
});
