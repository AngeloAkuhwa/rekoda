/**
 * Who an operator IS, rather than what they know (P0-2).
 *
 * The operator plane can move money across every tenant in the estate: it
 * refunds, it resolves payment exceptions, it changes a business's plan. Until
 * now the whole of that authority was one reusable static header secret, and
 * the audit row said whatever the caller typed into an `actor` field. Two
 * separate problems in one shape: possession is not identity, and a claim is
 * not a fact.
 *
 * This verifies a signed identity instead. Deliberately provider-neutral: the
 * issuer, audience and key set are deployment configuration, so Cloudflare
 * Access, an IAP or a plain OIDC provider all satisfy it and none of them
 * appears in this file. What the code insists on is the shape of the proof.
 *
 * `jose` does the cryptography. Hand-rolling JWT verification is a well-known
 * way to ship an `alg: none` acceptance or a key-confusion bug, and this is
 * the one boundary in the codebase where that would hand somebody every
 * merchant's money.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * What an operator may do, not merely that they exist.
 *
 * A valid operator token must not automatically carry estate-wide refund,
 * privacy-deletion and billing authority at once. These are the five things
 * the plane can currently do, and a token says which of them it is for.
 */
export const OPERATOR_SCOPES = [
  'ops:read',
  'ops:payment',
  'ops:privacy',
  'ops:billing',
  'ops:security',
] as const;
export type OperatorScope = (typeof OPERATOR_SCOPES)[number];

/** The verified caller. `subject` is the audit actor, and nothing else is. */
export interface OperatorIdentity {
  subject: string;
  scopes: readonly OperatorScope[];
}

export interface OperatorAuthConfig {
  issuer: string;
  audience: string;
  jwksUrl: string;
  /** Where the scopes live. Providers disagree; the claim name is theirs. */
  scopeClaim: string;
}

/** A caller the verifier could not turn into an identity. */
export class OperatorAuthRefused extends Error {}

/**
 * A remote key set, fetched once and cached by `jose` with its own rotation
 * handling. Built per configuration rather than per request: a JWKS fetched on
 * every call is a denial-of-service lever pointed at the identity provider.
 */
export function operatorVerifier(config: OperatorAuthConfig): {
  verify(token: string): Promise<OperatorIdentity>;
} {
  const keys = createRemoteJWKSet(new URL(config.jwksUrl));

  return {
    async verify(token: string): Promise<OperatorIdentity> {
      let payload: JWTPayload;
      try {
        /* `issuer` and `audience` are checked by jose against the token, and
         * both matter: a signature proves who MINTED a token, not who it was
         * minted FOR. A token issued by the same provider for a different
         * application is a valid signature and an invalid caller. Expiry and
         * not-before are enforced by default; the clock tolerance is left at
         * jose's zero rather than widened, because an operator plane is not a
         * place to be generous about a token's lifetime. */
        ({ payload } = await jwtVerify(token, keys, {
          issuer: config.issuer,
          audience: config.audience,
        }));
      } catch {
        /* One refusal for every cause. A caller learning WHICH check failed
         * learns whether they have the right issuer, the right audience or
         * merely a stale token, and that is a map. */
        throw new OperatorAuthRefused('operator identity could not be verified');
      }

      const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
      if (!subject) throw new OperatorAuthRefused('operator identity carries no subject');

      return { subject, scopes: scopesOf(payload[config.scopeClaim]) };
    },
  };
}

/**
 * Scopes, from whichever shape the provider chose.
 *
 * OIDC's `scope` is a space-delimited string; plenty of providers send an
 * array instead. Both are read, and anything that is not one of Rekoda's five
 * is DROPPED rather than carried: an unknown scope cannot authorise anything,
 * and keeping it would only make a log line look like permission.
 */
function scopesOf(claim: unknown): readonly OperatorScope[] {
  const raw =
    typeof claim === 'string'
      ? claim.split(/\s+/)
      : Array.isArray(claim)
        ? claim.filter((value): value is string => typeof value === 'string')
        : [];
  const known = new Set<OperatorScope>();
  for (const value of raw) {
    if ((OPERATOR_SCOPES as readonly string[]).includes(value)) known.add(value as OperatorScope);
  }
  return [...known];
}
