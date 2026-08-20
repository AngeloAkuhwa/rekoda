import { Controller, ForbiddenException, Get, Headers, Inject } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { events, jobsRepo, type Db } from '@rekoda/db';
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
 * would quietly become a feature. Nothing here names a business or a person.
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
    const expected = this.config.operatorSecret;
    if (!expected || !secret || !matchesSecret(secret, expected)) {
      throw new ForbiddenException('operator secret required');
    }

    const [queue, meta, paystack] = await Promise.all([
      this.workerDb ? jobsRepo.queueHealth(this.workerDb) : Promise.resolve(null),
      events.eventHealth(this.db, 'meta'),
      events.eventHealth(this.db, 'paystack'),
    ]);
    return { queue, meta, paystack };
  }
}

/** Constant-time, and length-safe: `timingSafeEqual` throws on a mismatch. */
function matchesSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
