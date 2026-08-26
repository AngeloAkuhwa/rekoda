import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { opsExceptionsResponse, opsRefundRequest, opsResolveEventRequest } from '@rekoda/contracts';
import type { OpsExceptionsResponse } from '@rekoda/contracts';
import {
  billingRepo,
  events,
  jobsRepo,
  marginRepo,
  settleRepo,
  subscriptionsRepo,
  withBusiness,
  type Db,
} from '@rekoda/db';
import {
  estateCount,
  estateMargin,
  GRADUATION_NUDGE_K,
  margin,
  payingCount,
  STARTER_CAP_K,
  usagePeriod,
  type Margin,
} from '@rekoda/core';
import { CONFIG, type ApiConfig } from '../config.js';
import { DB, WORKER_DB } from '../db/db.module.js';

/**
 * What an operator needs to know at 2am (MASTER-PLAN §6.4).
 *
 * Everything here has been happening since the day it shipped with nowhere to
 * read it: jobs die and are marked dead, the paystack pump marks events it
 * could not attribute and calls those marks "the admin exception queue",
 * signature checks fail. None of it had a surface, so all of it was silence.
 *
 * Deliberately numbers and not rows. This is a thing to poll and alarm on,
 * not an admin console — and a console is exactly where a cross-tenant read
 * would quietly become a feature. Nothing here names a business or a person:
 * the margin report is per-business and carries the id, because the id is
 * what an operator acts on, and a name would be a merchant list on a
 * plaintext header's say-so.
 *
 * Gated on the deployment secret rather than a session, for the same reason
 * the plan endpoint is: no merchant should be able to see the platform's
 * queue depth, and no session is the right credential for a question that
 * spans every tenant.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('v1/ops')
export class OpsController {
  constructor(
    @Inject(CONFIG) private readonly config: ApiConfig,
    @Inject(DB) private readonly db: Db,
    /**
     * `jobs` is under FORCE row-level security, so the application role sees
     * an empty queue rather than everybody's — which would report a healthy
     * zero forever. Counting across tenants needs the worker credential, and
     * a process without one says so instead of guessing.
     */
    @Inject(WORKER_DB) private readonly workerDb: Db | null,
  ) {}

  @Get('health')
  async health(@Headers('x-rekoda-operator-secret') secret: string | undefined): Promise<{
    /** Null when this process holds no worker credential — poll one that does. */
    queue: Awaited<ReturnType<typeof jobsRepo.queueHealth>> | null;
    meta: Awaited<ReturnType<typeof events.eventHealth>>;
    paystack: Awaited<ReturnType<typeof events.eventHealth>>;
  }> {
    this.assertOperator(secret);

    const [queue, meta, paystack] = await Promise.all([
      this.workerDb ? jobsRepo.queueHealth(this.workerDb) : Promise.resolve(null),
      events.eventHealth(this.db, 'meta'),
      events.eventHealth(this.db, 'paystack'),
    ]);
    return { queue, meta, paystack };
  }

  /**
   * What Rekoda earns against what Rekoda spends, for one billing month.
   *
   * `usage_events` has costed every message, model call and document since
   * metering shipped and nothing has ever read it, which means the number
   * that decides whether the pricing model survives contact with real
   * merchants was being written to a table and never looked at.
   *
   * Revenue is the plan price and nothing else: add-on packs exist in
   * `docs/pricing-model.md` and in no table, so counting them would be
   * inventing them. A trial earns zero and still costs, which is the truthful
   * shape — it is acquisition spend, and hiding it would flatter the margin.
   *
   * Ids, not names, in keeping with the rest of this controller. The id is
   * what an operator acts on: it is exactly what `POST /v1/businesses/plan`
   * already takes.
   *
   * `total` is counted over every tenant and `businesses` is the costly tail,
   * capped. Summing a capped page into a total is how a platform number goes
   * quietly wrong: it would keep looking plausible the whole time it was
   * shrinking.
   */
  /**
   * Who is approaching Paystack's Starter cap (ADR 0019, fix-plan 6 M5d).
   *
   * The graduation table made this a day-one requirement: "a merchant who
   * discovers the cap by having collections stop mid-sale is a merchant
   * Rekoda failed". Lifetime VERIFIED collections per business, ids and
   * amounts only, with the two thresholds stated so the operator reading it
   * does not have to remember them. `approaching_cap` is the alert: it means
   * the one-time WhatsApp nudge has fired (or is about to on the next
   * booking) and a human should be ready to help with registration.
   */
  @Get('graduation')
  async graduation(@Headers('x-rekoda-operator-secret') secret: string | undefined): Promise<{
    nudgeAtK: number;
    capK: number;
    businesses: Array<{
      businessId: string;
      collectedK: number;
      state: 'collecting' | 'approaching_cap' | 'capped_risk';
    }>;
  }> {
    this.assertOperator(secret);
    if (!this.workerDb) {
      throw new ServiceUnavailableException(
        'graduation needs the worker credential (WORKER_DATABASE_URL); poll a process that holds one',
      );
    }
    const rows = await settleRepo.collectedByBusiness(this.workerDb);
    return {
      nudgeAtK: GRADUATION_NUDGE_K,
      capK: STARTER_CAP_K,
      businesses: rows.map((row) => ({
        businessId: row.businessId,
        collectedK: row.collectedK,
        state:
          row.collectedK >= STARTER_CAP_K
            ? ('capped_risk' as const)
            : row.collectedK >= GRADUATION_NUDGE_K
              ? ('approaching_cap' as const)
              : ('collecting' as const),
      })),
    };
  }

  @Get('margin')
  async marginReport(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Query('period') period?: string,
  ): Promise<{
    period: string;
    /** Months with any metered usage, newest first. Saves guessing. */
    availablePeriods: string[];
    /**
     * Over every tenant, counted rather than listed, so it stays true when
     * the estate outgrows the page of rows below it.
     */
    total: Margin & { businesses: number; paying: number; spending: number; events: number };
    byProvider: Awaited<ReturnType<typeof marginRepo.costByProvider>>;
    /**
     * The same period split by what was actually bought: which message
     * category, which model role. Spec §24 separates the message categories
     * because utility and marketing differ by roughly eightfold, and grouped
     * by provider alone that shift is invisible - the Meta total moves and
     * nothing says which way the mix went.
     */
    byUsageType: Awaited<ReturnType<typeof marginRepo.costByUsageType>>;
    /** The costliest merchants, capped. `total` covers the ones not here. */
    businesses: Array<
      Margin & { businessId: string; plan: string; events: number; createdAt: string }
    >;
  }> {
    this.assertOperator(secret);

    /**
     * No worker credential means the query would run under `tenant_isolation`
     * with no tenant pinned and come back empty. An empty margin report and a
     * genuinely costless month are indistinguishable to whoever reads it, so
     * this refuses rather than answers.
     */
    if (!this.workerDb) {
      throw new ServiceUnavailableException(
        'margin needs the worker credential (WORKER_DATABASE_URL); poll a process that holds one',
      );
    }

    const wanted = period ?? usagePeriod(new Date());
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(wanted)) {
      throw new BadRequestException('period must be YYYY-MM');
    }

    const [rows, byProvider, byUsageType, availablePeriods, census, totals] = await Promise.all([
      marginRepo.costByBusiness(this.workerDb, wanted),
      marginRepo.costByProvider(this.workerDb, wanted),
      marginRepo.costByUsageType(this.workerDb, wanted),
      marginRepo.meteredPeriods(this.workerDb),
      marginRepo.planCensus(this.workerDb),
      marginRepo.periodTotals(this.workerDb, wanted),
    ]);

    return {
      period: wanted,
      availablePeriods,
      total: {
        ...estateMargin(census, totals.costK),
        businesses: estateCount(census),
        paying: payingCount(census),
        spending: totals.spending,
        events: totals.events,
      },
      byProvider,
      byUsageType,
      businesses: rows.map((row) => ({
        businessId: row.businessId,
        plan: row.plan,
        events: row.events,
        createdAt: row.createdAt.toISOString(),
        ...margin({ plan: row.plan, costK: row.costK }),
      })),
    };
  }

  /**
   * One merchant's commercial state, for the operator about to act on it.
   *
   * Three things that were each being written and never read: the plan and
   * its cycle, every charge Rekoda has made, and the upgrade requests a
   * merchant has typed in chat. `recordUpgradeRequest` has been storing those
   * since before self-service billing existed, and nothing has ever shown
   * them to anybody, so a merchant asking three times to pay us was three
   * rows nobody saw.
   *
   * Ids and references, never names, in keeping with the rest of this
   * controller.
   */
  @Get('business/:businessId')
  async businessBilling(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Param('businessId') businessId: string,
  ): Promise<{
    plan: string;
    renewsAt: string | null;
    cycleStartedAt: string | null;
    pendingPlan: string | null;
    paymentFailedAt: string | null;
    charges: Array<{
      reference: string;
      kind: string;
      plan: string | null;
      packId: string | null;
      amountK: number;
      status: string;
      createdAt: string;
    }>;
    upgradeRequests: Array<{ fromPlan: string; at: string }>;
  }> {
    this.assertOperator(secret);
    if (!UUID.test(businessId)) throw new BadRequestException('businessId must be a UUID');

    return withBusiness(this.db, businessId, async (tx) => {
      const subscription = await subscriptionsRepo.subscriptionFor(tx, businessId);
      if (!subscription) throw new NotFoundException('no such business');

      const charges = await subscriptionsRepo.chargesFor(tx, businessId);
      const upgradeRequests = await billingRepo.upgradeRequestsFor(tx, businessId);
      return {
        plan: subscription.plan,
        renewsAt: subscription.planExpiresAt?.toISOString() ?? null,
        cycleStartedAt: subscription.cycleStartedAt?.toISOString() ?? null,
        pendingPlan: subscription.pendingPlan,
        paymentFailedAt: subscription.paymentFailedAt?.toISOString() ?? null,
        charges: charges.rows.map((charge) => ({
          reference: charge.reference,
          kind: charge.kind,
          plan: charge.plan,
          packId: charge.packId,
          amountK: charge.amountK,
          status: charge.status,
          createdAt: charge.createdAt.toISOString(),
        })),
        upgradeRequests: upgradeRequests.map((request) => ({
          fromPlan: request.fromPlan,
          at: request.at.toISOString(),
        })),
      };
    });
  }

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
  @HttpCode(200)
  async refund(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ refunded: true; status: string; refundedK: number }> {
    this.assertOperator(secret);

    const input = opsRefundRequest.safeParse(body);
    if (!input.success) {
      throw new BadRequestException(
        'businessId, reference, amountK (positive kobo) and reason are required',
      );
    }
    const { businessId, reference, amountK, reason, actor } = input.data;

    return withBusiness(this.db, businessId, async (tx) => {
      const charge = await subscriptionsRepo.refundCharge(tx, reference, amountK, new Date(), {
        actor,
        reason,
      });
      /* Refused because the charge was never paid, has gone, or this refund
       * would take back more than we ever took. All three are an operator
       * mistake to correct rather than an error to retry. */
      if (!charge) throw new BadRequestException('that charge cannot be refunded by that amount');

      return { refunded: true as const, status: charge.status, refundedK: amountK };
    });
  }

  /**
   * The exception queue, as rows (MASTER-PLAN §6.4).
   *
   * The one place on this surface that returns rows rather than numbers, and
   * it earns the exception: an unattributed event belongs to no tenant, so no
   * merchant can ever see it. If an operator cannot, nobody can, and the
   * pump's marks accumulate forever with the only remedy being somebody
   * reading `external_events` by hand at 2am.
   *
   * Still no payload and still no names. Provider bodies are sealed under
   * `VAULT_KEY` and carry the sender's number and their message; a triage
   * list that unsealed them would be a plaintext feed of every merchant's
   * conversations behind one header.
   *
   * Worker-credentialed, because the queue spans tenants by its nature and an
   * empty answer from a process without the credential would be
   * indistinguishable from a quiet night.
   */
  @Get('exceptions')
  async exceptions(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Query('limit') limitParam?: string,
  ): Promise<OpsExceptionsResponse> {
    this.assertOperator(secret);
    if (!this.workerDb) {
      throw new ServiceUnavailableException('this process holds no worker credential');
    }

    const limit = Math.min(Math.max(Number(limitParam) || 50, 1), 200);
    const queue = await events.exceptionQueue(this.workerDb, limit);
    return opsExceptionsResponse.parse({
      stuck: queue.stuck.map(toEventView),
      flagged: queue.flagged.map(toEventView),
    });
  }

  /**
   * Work one exception: who decided, and what they decided.
   *
   * The update is conditional on the row still being open, so two operators
   * acting at once produce one resolution and the loser is told rather than
   * silently overwriting the first decision. `error` is never touched: it is
   * the reason the row was flagged, and a resolution that erased it would
   * destroy the only record of what went wrong.
   */
  @Post('exceptions/:id/resolve')
  @HttpCode(200)
  async resolveException(
    @Headers('x-rekoda-operator-secret') secret: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<{ resolved: true }> {
    this.assertOperator(secret);
    if (!this.workerDb) {
      throw new ServiceUnavailableException('this process holds no worker credential');
    }
    if (!UUID.test(id)) throw new BadRequestException('not an event id');

    const input = opsResolveEventRequest.safeParse(body);
    if (!input.success) {
      throw new BadRequestException('resolution (at least 4 characters) and actor are required');
    }

    const resolved = await events.resolveEvent(
      this.workerDb,
      id,
      input.data.resolution,
      input.data.actor,
    );
    if (!resolved) throw new NotFoundException('no open exception with that id');
    return { resolved: true as const };
  }

  private assertOperator(secret: string | undefined): void {
    const expected = this.config.operatorSecret;
    if (!expected || !secret || !matchesSecret(secret, expected)) {
      throw new ForbiddenException('operator secret required');
    }
  }
}

/**
 * Constant-time secret comparison with no length oracle.
 *
 * Comparing digests rather than the strings means the observable work is
 * identical whatever the caller sent: a raw length pre-check answered
 * faster for wrong-length guesses, which quietly told an attacker how long
 * the secret is. Hashing first costs microseconds and says nothing.
 */
function matchesSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** Row to wire. Nothing here that a payload or a name could reach. */
function toEventView(row: {
  id: string;
  provider: string;
  eventType: string;
  businessId: string | null;
  error: string | null;
  signatureValid: number;
  createdAt: Date;
  ageSeconds: number;
}) {
  return {
    id: row.id,
    provider: row.provider,
    eventType: row.eventType,
    businessId: row.businessId,
    error: row.error,
    signatureValid: row.signatureValid === 1 ? (1 as const) : (0 as const),
    createdAt: row.createdAt.toISOString(),
    ageSeconds: Math.max(0, row.ageSeconds),
  };
}
