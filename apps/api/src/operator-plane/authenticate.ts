/**
 * Who is calling the operator plane, and may they do this (P0-2), free of any web framework.
 *
 * Two rules. A caller presents a VERIFIED identity (a signed token checked against the configured
 * issuer, audience and key set), not a shared secret; and the identity must carry the scope for
 * the act. Production has only the verified path: the configuration refuses to build the
 * development secret there. Outside production, with no verifier configured, the development
 * secret stands in and carries every scope, so a developer can drive the routes without an
 * identity provider.
 *
 * One implementation for the API's `OperatorGuard` and for the dedicated operator process
 * (OD-51.1), so the two cannot disagree about what a valid operator is.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  operatorVerifier,
  OperatorAuthRefused,
  OPERATOR_SCOPES,
  type OperatorAuthConfig,
  type OperatorIdentity,
  type OperatorScope,
} from '../auth/operator-identity.js';

export interface OperatorAuthSettings {
  /** The verified path. Null only outside production. */
  operatorAuth: OperatorAuthConfig | null;
  /** The development stand-in. Always null in production (the configuration refuses it). */
  operatorSecret: string | null;
}

/** No identity, or one that could not be verified: a 401. The message is safe to return. */
export class OperatorUnauthenticated extends Error {}

/** A verified identity without the scope the act needs: a 403 naming what is missing. */
export class OperatorMissingScope extends Error {
  constructor(readonly missing: readonly OperatorScope[]) {
    super(`operator token is missing: ${missing.join(', ')}`);
  }
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Constant-time secret comparison with no length oracle: comparing digests means the observable
 * work is identical whatever the caller sent.
 */
function matchesSecret(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Builds the identifier for one process. The remote key set is created on first use and kept:
 * a JWKS fetched on every call is a denial-of-service lever pointed at the identity provider.
 */
export function operatorAuthenticator(settings: OperatorAuthSettings): {
  identify(headers: HeaderBag): Promise<OperatorIdentity>;
} {
  let verifier: ReturnType<typeof operatorVerifier> | null = null;
  return {
    async identify(headers: HeaderBag): Promise<OperatorIdentity> {
      const operatorAuth = settings.operatorAuth;
      if (operatorAuth) {
        /* The scheme is case-insensitive in RFC 7235, and a proxy that normalises it is not a
         * caller to refuse. */
        const bearer = /^bearer +(.+)$/i.exec(header(headers, 'authorization') ?? '');
        if (!bearer) throw new OperatorUnauthenticated('operator identity required');
        verifier ??= operatorVerifier(operatorAuth);
        try {
          return await verifier.verify(bearer[1]!);
        } catch (error) {
          if (error instanceof OperatorAuthRefused)
            throw new OperatorUnauthenticated(error.message);
          throw error;
        }
      }
      /* No verifier configured. In production the configuration has already refused to boot, so
       * this is a development or test process and the legacy secret stands in, with every scope:
       * outside production the point is to exercise the routes, not to model an organisation. */
      const secret = header(headers, 'x-rekoda-operator-secret');
      const expected = settings.operatorSecret;
      if (!expected || !secret || !matchesSecret(secret, expected)) {
        throw new OperatorUnauthenticated('operator identity required');
      }
      return { subject: 'local:operator-secret', scopes: [...OPERATOR_SCOPES] };
    },
  };
}

/** Refuses an identity that lacks any of `required`, naming what is missing. */
export function requireOperatorScopes(
  identity: OperatorIdentity,
  required: readonly OperatorScope[],
): void {
  const missing = required.filter((scope) => !identity.scopes.includes(scope));
  if (missing.length > 0) throw new OperatorMissingScope(missing);
}

/**
 * What an operator-plane subject may be when it is recorded as an audit actor: 1 to 255 printable
 * ASCII characters with no space. The same rule the operator plan writers enforce in the database
 * (`^operator:[!-~]{1,255}$`), so a subject the database would refuse is refused first, as the
 * caller's problem. Null when the subject cannot be recorded.
 */
export function auditActorOf(identity: OperatorIdentity): string | null {
  return typeof identity.subject === 'string' && /^[!-~]{1,255}$/.test(identity.subject)
    ? `operator:${identity.subject}`
    : null;
}
