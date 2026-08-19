import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { MeResponse } from '@rekoda/contracts';
import { AuthService, SessionInvalid } from './auth.service.js';

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  auth?: MeResponse;
}

/**
 * Resolves the bearer session and attaches the caller's identity — including
 * the business it is bound to and the role held there.
 *
 * The session is the sole source of `businessId`. It is never read from the
 * request body or a query param, because a caller-supplied tenant id is a
 * cross-tenant read waiting for someone to forget a check.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    if (!value?.startsWith('Bearer ')) throw new UnauthorizedException('no session');

    try {
      request.auth = await this.auth.resolveSession(value.slice('Bearer '.length));
      return true;
    } catch (error) {
      if (error instanceof SessionInvalid) throw new UnauthorizedException(error.message);
      throw error;
    }
  }
}
