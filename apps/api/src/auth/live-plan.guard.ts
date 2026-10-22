import { ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { usageRepo, withBusiness, type Db } from '@rekoda/db';
import { DB } from '../db/db.module.js';
import type { AuthedRequest } from './session.guard.js';

export const LIVE_PLAN_KEY = 'rekoda:needs-live-plan';

/**
 * Marks a dashboard door that ADDS to the books or starts new work (G-44).
 *
 * A lapsed plan keeps the books readable, collectible and correctable (spec
 * §4.5) but records nothing new, the same line the Chat path draws
 * (`DETERMINISTIC_ACCESS`). Collecting a payment, voiding, crediting, stopping
 * a schedule and deleting data are deliberately NOT marked.
 */
export const NeedsLivePlan = () => SetMetadata(LIVE_PLAN_KEY, true);

/**
 * List after `SessionGuard`. The session carries the STORED plan, and a trial
 * that ran out is still stored as `trial`, so the plan is read again here with
 * the trial clock applied (`usageRepo.planFor`), the same answer Chat, billing
 * and the shop judge against. `expired` is what a lapsed trial and a lapsed
 * paid plan share.
 */
@Injectable()
export class LivePlanGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const needed = this.reflector.getAllAndOverride<boolean | undefined>(LIVE_PLAN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!needed) return true;

    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    // A mis-ordered guard list becomes a 401, never an open door.
    if (!auth) throw new UnauthorizedException('no session');

    const plan = await withBusiness(this.db, auth.businessId, (tx) =>
      usageRepo.planFor(tx, auth.businessId),
    );
    if (plan === 'expired') {
      throw new ForbiddenException(
        'Your plan has ended, so Rekoda cannot record anything new. Your records are safe ' +
          'and still here to read, collect on and export. Choose a plan to carry on recording.',
      );
    }
    return true;
  }
}
