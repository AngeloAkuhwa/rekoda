/**
 * The verifier, against tokens somebody would actually try.
 *
 * This is the boundary where a mistake hands over every merchant's money, so
 * it is tested with real cryptography rather than a stubbed `jwtVerify`: a
 * local key pair, a real JWKS served over HTTP, and tokens minted for each
 * attack the shape invites. A stub would prove that the stub was called.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { operatorVerifier, OperatorAuthRefused } from './operator-identity.js';

const ISSUER = 'https://issuer.test/';
const AUDIENCE = 'rekoda-operator-plane';

let server: Server;
let jwksUrl: string;
let sign: (claims: Record<string, unknown>, over?: Partial<Signing>) => Promise<string>;

interface Signing {
  issuer: string;
  audience: string;
  expiresIn: string;
}

/** A second key pair nothing trusts, for the forged-signature case. */
let strangerKey: CryptoKey;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const stranger = await generateKeyPair('RS256', { extractable: true });
  strangerKey = stranger.privateKey;

  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'operator-test', alg: 'RS256' };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;

  sign = (claims, over = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'operator-test' })
      .setIssuer(over.issuer ?? ISSUER)
      .setAudience(over.audience ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(over.expiresIn ?? '5m')
      .sign(privateKey);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const verifier = () =>
  operatorVerifier({ issuer: ISSUER, audience: AUDIENCE, jwksUrl, scopeClaim: 'scope' });

describe('the operator identity verifier', () => {
  it('reads the subject and the scopes out of a token it can verify', async () => {
    const token = await sign({ sub: 'angelo@rekoda.app', scope: 'ops:read ops:payment' });

    expect(await verifier().verify(token)).toEqual({
      subject: 'angelo@rekoda.app',
      scopes: ['ops:read', 'ops:payment'],
    });
  });

  it('reads scopes from an array as well, because providers disagree', async () => {
    const token = await sign({ sub: 'ada', scope: ['ops:billing', 'ops:read'] });

    const identity = await verifier().verify(token);
    expect([...identity.scopes].sort()).toEqual(['ops:billing', 'ops:read']);
  });

  it('reads them from whichever claim the deployment names', async () => {
    const token = await sign({ sub: 'ada', permissions: 'ops:security' });

    const named = operatorVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl,
      scopeClaim: 'permissions',
    });
    expect((await named.verify(token)).scopes).toEqual(['ops:security']);
    /* The same token read under the default claim carries NO authority,
     * rather than falling back to something. */
    expect((await verifier().verify(token)).scopes).toEqual([]);
  });

  it('drops a scope it does not know instead of carrying it', async () => {
    const token = await sign({ sub: 'ada', scope: 'ops:read ops:everything admin superuser' });

    /* An unknown scope cannot authorise anything, and keeping it would put a
     * string that reads like permission into logs and error messages. */
    expect((await verifier().verify(token)).scopes).toEqual(['ops:read']);
  });

  it('refuses a token minted for a different audience', async () => {
    const token = await sign({ sub: 'ada', scope: 'ops:read' }, { audience: 'some-other-app' });

    // A valid signature from the right provider is still the wrong caller.
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(OperatorAuthRefused);
  });

  it('refuses a token from a different issuer', async () => {
    const token = await sign({ sub: 'ada', scope: 'ops:read' }, { issuer: 'https://elsewhere/' });

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(OperatorAuthRefused);
  });

  it('refuses an expired token, with no grace', async () => {
    const token = await sign({ sub: 'ada', scope: 'ops:read' }, { expiresIn: '-1s' });

    await expect(verifier().verify(token)).rejects.toBeInstanceOf(OperatorAuthRefused);
  });

  it('refuses a token signed by a key the JWKS does not publish', async () => {
    const forged = await new SignJWT({ sub: 'ada', scope: 'ops:payment' })
      .setProtectedHeader({ alg: 'RS256', kid: 'operator-test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(strangerKey);

    /* The `kid` names a key we do publish. Only the signature says otherwise,
     * which is the whole point of verifying it. */
    await expect(verifier().verify(forged)).rejects.toBeInstanceOf(OperatorAuthRefused);
  });

  it('refuses an unsigned token', async () => {
    const claims = Buffer.from(
      JSON.stringify({ sub: 'ada', iss: ISSUER, aud: AUDIENCE, scope: 'ops:payment' }),
    ).toString('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');

    await expect(verifier().verify(`${header}.${claims}.`)).rejects.toBeInstanceOf(
      OperatorAuthRefused,
    );
  });

  it('refuses a verified token that names nobody', async () => {
    const token = await sign({ scope: 'ops:read' });

    /* Every audit row on this plane is the subject. A token without one would
     * write an anonymous refund into the trail. */
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(OperatorAuthRefused);
  });

  it('says the same thing whatever went wrong', async () => {
    const wrongAudience = await sign({ sub: 'ada' }, { audience: 'other' });
    const expired = await sign({ sub: 'ada' }, { expiresIn: '-1s' });

    const messages = await Promise.all(
      [wrongAudience, expired].map((token) =>
        verifier()
          .verify(token)
          .then(
            () => 'accepted',
            (error: Error) => error.message,
          ),
      ),
    );
    // Telling a caller WHICH check failed hands them a map of the deployment.
    expect(new Set(messages).size).toBe(1);
  });
});
