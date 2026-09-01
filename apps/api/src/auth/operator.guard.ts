/**
 * The operator plane's front door (P0-2).
 *
 * Two rules, and the second is the one that was missing.
 *
 * A caller must present a VERIFIED identity, not a shared secret. And the
 * identity must carry the scope for what they are about to do: an operator
 * token is not a master key, and "authenticated" is not "may refund every
 * merchant in the estate".
 *
 * Production fails CLOSED. If operator authentication is not configured, the
 * operator plane is unavailable — it does not quietly fall back to the static
 * secret, because a fallback that exists is a fallback somebody reaches for
 * during an incident, and the incident is exactly when estate-wide authority
 * should be hardest to get.
 *
 * Outside production the static secret still works, so a developer can drive
 * these routes without standing up an identity provider. That adapter is
 * unreachable in production by construction rather than by convention: the
 * config layer refuses to build it.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CONFIG, type ApiConfig } from '../config.js';
import {
  operatorVerifier,
  OperatorAuthRefused,
  OPERATOR_SCOPES,
  type OperatorIdentity,
  type OperatorScope,
} from './operator-identity.js';

export const OPERATOR_SCOPES_KEY = 'operatorScopes';

/**
 * What this route needs. Mandatory: a route with no declaration is a route
 * nobody decided the authority for, and `operatorRoutesDeclareScopes` in the
 * suite refuses to let one exist.
 */
export const OperatorScopes = (...scopes: OperatorScope[]) =>
  SetMetadata(OPERATOR_SCOPES_KEY, scopes);

export interface OperatorRequest {
  headers: Record<string, string | string[] | undefined>;
  operator?: OperatorIdentity;
}

@Injectable()
export class OperatorGuard implements CanActivate {
  private verifier: ReturnType<typeof operatorVerifier> | null = null;

  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<OperatorScope[] | undefined>(
      OPERATOR_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      /* Not a 403. A route that reached here without declaring its authority
       * is a mistake in this repository, not in the caller's request, and it
       * should read like one in the logs. */
      throw new ServiceUnavailableException('this operator route declares no scope');
    }

    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const identity = await this.identify(request);

    const missing = required.filter((scope) => !identity.scopes.includes(scope));
    if (missing.length > 0) {
      /* Named, unlike the authentication refusal above. The caller has proved
       * who they are; telling them which scope they lack is telling them
       * something about their OWN token. */
      throw new ForbiddenException(`operator token is missing: ${missing.join(', ')}`);
    }

    request.operator = identity;
    return true;
  }

  private async identify(request: OperatorRequest): Promise<OperatorIdentity> {
    const auth = header(request, 'authorization');
    const operatorAuth = this.config.operatorAuth;

    if (operatorAuth) {
      /* The scheme is case-insensitive in RFC 7235, and a proxy that
       * normalises it is not a caller we should refuse. */
      const bearer = /^bearer +(.+)$/i.exec(auth ?? '');
      if (!bearer) {
        throw new UnauthorizedException('operator identity required');
      }
      this.verifier ??= operatorVerifier(operatorAuth);
      try {
        return await this.verifier.verify(bearer[1]!);
      } catch (error) {
        if (error instanceof OperatorAuthRefused) {
          throw new UnauthorizedException(error.message);
        }
        throw error;
      }
    }

    /* No verifier configured. In production the config layer has already
     * refused to boot, so reaching here means a development or test process,
     * and the legacy secret stands in — with every scope, because outside
     * production the point is to exercise the routes rather than to model an
     * organisation. */
    const secret = header(request, 'x-rekoda-operator-secret');
    const expected = this.config.operatorSecret;
    if (!expected || !secret || !matchesSecret(secret, expected)) {
      throw new UnauthorizedException('operator identity required');
    }
    return { subject: 'local:operator-secret', scopes: [...OPERATOR_SCOPES] };
  }
}

function header(request: OperatorRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Constant-time secret comparison with no length oracle, unchanged from the
 * one this replaces: comparing digests means the observable work is identical
 * whatever the caller sent.
 */
function matchesSecret(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
