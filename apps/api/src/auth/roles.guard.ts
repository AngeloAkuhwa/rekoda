import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthedRequest } from './session.guard.js';

export type Role = 'owner' | 'accountant' | 'delegate';

export const ROLES_KEY = 'rekoda:roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Role enforcement at the application edge (spec §35, MASTER-PLAN 5.2.2).
 *
 * RLS is the net, not the mechanism: it answers "which tenant" and has nothing
 * to say about "which role". An accountant is inside the tenant, so every row
 * passes the policy — only this guard stands between them and settings.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const auth = request.auth;
    // Ordering matters: RolesGuard must be listed after SessionGuard, and this
    // is what turns a mis-ordered guard list into a 401 rather than an open door.
    if (!auth) throw new UnauthorizedException('no session');

    if (!required.includes(auth.role as Role)) {
      throw new ForbiddenException(`this action requires: ${required.join(', ')}`);
    }
    return true;
  }
}
