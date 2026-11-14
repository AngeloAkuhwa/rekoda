/**
 * Whether this process serves the operator plan routes at all (OD-51.1).
 *
 * In production it does not: the billing-operator credential lives in the dedicated operator
 * process (`operator-main.ts`), the configuration refuses to hand it to the API, and Caddy sends
 * the plan paths there. A request that reaches the API for one anyway is answered 404 BEFORE any
 * identity is read, so the API is not a second place an operator token for plan changes could be
 * presented, and nothing about the route can be learned from it.
 *
 * In development and in tests one process may hold the credential, and then the routes are served
 * here, behind `OperatorGuard`, with the same operations the operator process runs.
 */
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';
import type { Db } from '@rekoda/db';
import { OPERATOR_DB } from '../db/db.module.js';

@Injectable()
export class OperatorPlaneServedHere implements CanActivate {
  constructor(@Inject(OPERATOR_DB) private readonly operatorDb: Db | null) {}

  canActivate(): boolean {
    if (!this.operatorDb) throw new NotFoundException('Cannot POST this route on this host');
    return true;
  }
}
