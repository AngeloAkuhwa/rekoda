/**
 * Push the shelf to Meta on a slow clock (remediation R3b).
 *
 * `CatalogueSyncService` diffs the catalogue against what was last pushed and
 * publishes only the difference, which makes re-running it cheap and makes
 * this sweep safe to run on a timer. Until now nothing called it, so a
 * merchant who changed a price in Rekoda kept selling at the old one through
 * their Meta catalogue until something else happened to trigger a push. There
 * was no something else.
 *
 * The clock is deliberately slow. A shelf's prices change far less often than
 * hourly, the diff means a pass with nothing to say costs one query per
 * business, and the push is a network call to somebody else's API.
 */
import { Logger } from '@nestjs/common';
import { wabaRepo, type Db } from '@rekoda/db';
import type { CatalogueSyncService } from './catalogue-sync.service.js';

export interface CatalogueSweepDeps {
  workerDb: Db;
  sync: Pick<CatalogueSyncService, 'syncNow'>;
}

/** How many businesses one pass will look at. */
export const CATALOGUE_SWEEP_BATCH = 50;

export async function sweepCatalogues(
  deps: CatalogueSweepDeps,
  limit = CATALOGUE_SWEEP_BATCH,
): Promise<number> {
  const log = new Logger('CatalogueSweep');
  const due = await wabaRepo.businessesWithCatalogue(deps.workerDb, limit);
  let pushed = 0;

  for (const { businessId } of due) {
    /* One merchant's failure is not the next merchant's problem: a bad token
     * or a provider outage on one connection must not stop the pass. The
     * outcome is already a value rather than an exception for everything the
     * service anticipates; this catch is for what it does not. */
    try {
      const outcome = await deps.sync.syncNow(businessId);
      if (outcome.outcome === 'synced') pushed += outcome.pushed;
    } catch (error) {
      log.warn(`catalogue sweep skipped a business: ${describe(error)}`);
    }
  }
  return pushed;
}

/** The reason, without the statement that produced it. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
