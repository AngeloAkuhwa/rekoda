/**
 * The guard's two refusals, which are different questions (P0-2).
 *
 * 401 is "I do not know who you are". 403 is "I know exactly who you are and
 * this is not yours". The plane used to answer both with one blanket 403,
 * which reads to an operator at 2am as a broken deployment when it is really
 * a missing scope, and to an attacker as the same wall either way.
 *
 * A third refusal has no caller at all: a route that reached the guard
 * without declaring what authority it needs is a mistake in this repository,
 * and it is answered 503 rather than being defaulted to something.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import type { ApiConfig } from '../config.js';
import { OperatorGuard, OPERATOR_SCOPES_KEY, type OperatorRequest } from './operator.guard.js';
import type { OperatorScope } from './operator-identity.js';

const SECRET = 'operator-secret-at-least-32-characters';
const ISSUER = 'https://issuer.test/';
const AUDIENCE = 'rekoda-operator-plane';

let server: Server;
let jwksUrl: string;
let mint: (scopes: string) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'guard-test', alg: 'RS256' };
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jwks.json`;

  mint = (scope: string) =>
    new SignJWT({ sub: 'ada@rekoda.app', scope })
      .setProtectedHeader({ alg: 'RS256', kid: 'guard-test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Only the two fields the guard reads. */
function configWith(over: Partial<ApiConfig>): ApiConfig {
  return { operatorSecret: null, operatorAuth: null, ...over } as ApiConfig;
}

/**
 * A context around one request, with the scopes a route would have declared.
 * `undefined` stands for the route that declared nothing.
 */
function contextFor(
  headers: Record<string, string>,
  declared: OperatorScope[] | undefined,
): { context: ExecutionContext; request: OperatorRequest } {
  const handler = function route(): void {};
  if (declared) Reflect.defineMetadata(OPERATOR_SCOPES_KEY, declared, handler);
  const request: OperatorRequest = { headers };
  const context = {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const guardWith = (config: ApiConfig) => new OperatorGuard(config, new Reflector());

describe('the operator guard outside production', () => {
  const config = configWith({ operatorSecret: SECRET });

  it('lets the development secret through, and records that it names nobody', async () => {
    const { context, request } = contextFor({ 'x-rekoda-operator-secret': SECRET }, ['ops:read']);

    expect(await guardWith(config).canActivate(context)).toBe(true);
    /* Deliberately not a person's name. Every audit row this writes says so,
     * which is the honest record of a shared credential. */
    expect(request.operator?.subject).toBe('local:operator-secret');
  });

  it('answers 401 for no secret and for a wrong one', async () => {
    for (const headers of [{}, { 'x-rekoda-operator-secret': 'x'.repeat(SECRET.length) }]) {
      await expect(
        guardWith(config).canActivate(contextFor(headers, ['ops:read']).context),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    }
  });

  it('answers 401 when no credential is configured at all', async () => {
    await expect(
      guardWith(configWith({})).canActivate(
        contextFor({ 'x-rekoda-operator-secret': SECRET }, ['ops:read']).context,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('the operator guard with a verified identity', () => {
  const config = () =>
    configWith({
      /* The static secret is still SET, and still unreachable: once a verifier
       * exists the guard never looks at the header. Production refuses the
       * combination outright; this proves the guard does not need it to. */
      operatorSecret: SECRET,
      operatorAuth: { issuer: ISSUER, audience: AUDIENCE, jwksUrl, scopeClaim: 'scope' },
    });

  it('names the token subject as the actor, not the header holder', async () => {
    const token = await mint('ops:read ops:payment');
    const { context, request } = contextFor({ authorization: `Bearer ${token}` }, ['ops:payment']);

    expect(await guardWith(config()).canActivate(context)).toBe(true);
    expect(request.operator?.subject).toBe('ada@rekoda.app');
  });

  it('answers 403, naming the scope, for an identity it verified but may not act', async () => {
    const token = await mint('ops:read');
    const { context } = contextFor({ authorization: `Bearer ${token}` }, ['ops:payment']);

    /* The whole point of scopes: a token minted to read a dashboard cannot
     * refund a merchant. Named, because it tells the caller about their OWN
     * token rather than about the deployment. */
    await expect(guardWith(config()).canActivate(context)).rejects.toThrow(/ops:payment/);
    await expect(guardWith(config()).canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('stops honouring the static secret the moment a verifier exists', async () => {
    const { context } = contextFor({ 'x-rekoda-operator-secret': SECRET }, ['ops:read']);

    await expect(guardWith(config()).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts the scheme in whatever case a proxy left it', async () => {
    const token = await mint('ops:read');
    const { context } = contextFor({ authorization: `bearer ${token}` }, ['ops:read']);

    expect(await guardWith(config()).canActivate(context)).toBe(true);
  });

  it('answers 401 for a token it cannot verify', async () => {
    const { context } = contextFor({ authorization: 'Bearer not-a-token' }, ['ops:read']);

    await expect(guardWith(config()).canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('a route that declares no authority', () => {
  it('is refused rather than defaulted, and reads as our mistake', async () => {
    const { context } = contextFor({ 'x-rekoda-operator-secret': SECRET }, undefined);

    /* Not a 403. Nothing is wrong with the caller's request. */
    await expect(
      guardWith(configWith({ operatorSecret: SECRET })).canActivate(context),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
