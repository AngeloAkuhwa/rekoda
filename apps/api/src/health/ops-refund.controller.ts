/**
 * `POST /v1/ops/refund` (ADR 0024; migrations 0230, 0235) on an API host.
 *
 * In production the dedicated operator process serves this path (Caddy routes it there, OD-51.1)
 * and the API holds no billing-operator credential, so here the route answers 404 before any
 * operator identity is read. In development and tests one process may hold the credential, and
 * the same operation runs here behind `OperatorGuard` and the `ops:payment` scope.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Db } from '@rekoda/db';
import { OperatorGuard, OperatorScopes, type OperatorRequest } from '../auth/operator.guard.js';
import { OperatorPlaneServedHere } from '../auth/operator-plane-served.guard.js';
import { operatorActor } from '../auth/operator-actor.js';
import { OPERATOR_DB } from '../db/db.module.js';
import { OperatorPlaneRefusal } from '../operator-plane/plan-operations.js';
import { recordRefundAsOperator } from '../operator-plane/refund-operations.js';

@Controller('v1/ops')
export class OpsRefundController {
  constructor(
    /** The billing-operator principal, where this host holds one (development; 0230 refunds). */
    @Inject(OPERATOR_DB) private readonly operatorDb: Db | null,
  ) {}

  /**
   * Record a refund against a charge (ADR 0024's matrix).
   *
   * THIS DOES NOT MOVE MONEY. Returning the naira is a Paystack action the
   * operator performs, and saying otherwise in a method name is how somebody
   * comes to believe a merchant has been paid because a row says so. What
   * this does is make the refund a fact Rekoda knows: the amount comes off
   * the charge, the status becomes `refunded` only when the whole of it is
   * back, and an audit row records who decided and under which rule.
   *
   * The plan is deliberately untouched. ADR 0024 refunds money in several
   * situations that all leave the merchant with the period they paid for, and
   * a refund that silently cancelled a subscription would be a second
   * decision nobody made.
   */
  @Post('refund')
  /* The 404 comes BEFORE the operator identity is read (G4a-1): on an API host without the
   * billing-operator credential the route does not exist, whoever asks. Method-level guards run
   * in the order listed, so this route sits on its own controller with no class-level guard. */
  @UseGuards(OperatorPlaneServedHere, OperatorGuard)
  @OperatorScopes('ops:payment')
  @HttpCode(200)
  async refund(
    @Req() request: OperatorRequest,
    @Body() body: unknown,
  ): Promise<{
    refunded: true;
    status: string;
    refundedK: number;
    revokedUnits: number;
    replayed: boolean;
  }> {
    /* The audit actor is the VERIFIED subject, never a name the caller sent.
     * A body field here meant whoever held the shared secret also chose who
     * the record said they were. */
    const actor = operatorActor(request);
    /* Since 0230 a refund is recorded on the billing-operator principal alone: in production the
     * dedicated operator process serves this path, and an API host with no operator credential
     * answers 404 (`OperatorPlaneServedHere`). A refusal (never paid, more than was charged, a
     * credited pack that is used, partial or past seven days) is the operator's mistake: a 400. */
    try {
      return await recordRefundAsOperator(this.operatorDb!, actor, body);
    } catch (error) {
      if (error instanceof OperatorPlaneRefusal) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
