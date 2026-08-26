/**
 * Recording what an outbound message cost Rekoda, under its Meta category.
 *
 * Shared rather than repeated because the two proactive sweeps and the reply
 * layer all need the identical row, and a cost table that disagrees with
 * itself between three call sites is worse than no cost table: it looks
 * authoritative.
 *
 * Telemetry, not a financial record. Spec §29 is explicit that `usage_events`
 * "is telemetry... never designed as a financial record", and that real money
 * Rekoda spends gets an immutable `PlatformCostEvent` in BL2. This is the
 * baseline that feeds the margin model until then.
 */
import { Logger } from '@nestjs/common';
import {
  billingPeriod,
  messageCostK,
  MESSAGE_COST_MICROS,
  type MessageCategory,
} from '@rekoda/core';
import { quotaRepo, withBusiness, type Db } from '@rekoda/db';

const log = new Logger('MessageCost');

/**
 * One `usage_events` row for one message that has ALREADY been sent.
 *
 * Never throws. The caller has by definition already spent the money and
 * delivered the message, and the sweeps that call this treat a thrown error
 * as "the send failed, try again tomorrow" — so letting a telemetry write
 * fail the caller would turn a lost cost row into a duplicate message to a
 * merchant. A missing row is a gap in a report; a duplicate billing reminder
 * is a merchant being told twice that their card failed.
 */
export async function recordMessageCost(
  appDb: Db,
  businessId: string,
  category: MessageCategory,
  fxNairaPerUsd: number,
  meta?: Record<string, unknown>,
): Promise<void> {
  const micros = MESSAGE_COST_MICROS[category];
  try {
    await withBusiness(appDb, businessId, (tx) =>
      quotaRepo.recordUsage(tx, {
        businessId,
        provider: 'meta',
        usageType: category,
        quantity: 1,
        providerCostMicros: micros,
        nairaEquivalentK: messageCostK(micros, fxNairaPerUsd),
        billingPeriod: billingPeriod(new Date()),
        ...(meta ? { meta } : {}),
      }),
    );
  } catch {
    log.warn(`business ${businessId}: ${category} sent but its cost row was not written`);
  }
}
