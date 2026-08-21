import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { events, jobsRepo, marginRepo, type Db } from '@rekoda/db';
import {
  estateCount,
  estateMargin,
  margin,
  payingCount,
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

    const [rows, byProvider, availablePeriods, census, totals] = await Promise.all([
      marginRepo.costByBusiness(this.workerDb, wanted),
      marginRepo.costByProvider(this.workerDb, wanted),
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
      businesses: rows.map((row) => ({
        businessId: row.businessId,
        plan: row.plan,
        events: row.events,
        createdAt: row.createdAt.toISOString(),
        ...margin({ plan: row.plan, costK: row.costK }),
      })),
    };
  }

  private assertOperator(secret: string | undefined): void {
    const expected = this.config.operatorSecret;
    if (!expected || !secret || !matchesSecret(secret, expected)) {
      throw new ForbiddenException('operator secret required');
    }
  }
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a mismatch. */
function matchesSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
