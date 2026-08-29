/**
 * Exchange rate snapshots (spec §16, Appendix A.1; PR-038).
 *
 * Write-and-read only, deliberately: the snapshot is immutable market fact
 * (0069 revokes UPDATE and DELETE), and the SELECTION logic — freshness
 * against the requested accounting timestamp, named resolver states — is
 * pure and lives in `@rekoda/core/fx`, where it is tested without a
 * database or a provider.
 */
import { eq } from 'drizzle-orm';
import type { RateSource } from '@rekoda/core';
import type { TenantDb } from '../client.js';
import { exchangeRateSnapshots } from '../schema/finance.js';

export interface RecordSnapshotInput {
  baseCurrency: string;
  quoteCurrency: string;
  /** Decimal string, full provider precision. */
  rate: string;
  effectiveAt: Date;
  source: RateSource;
  providerName: string;
  providerReference?: string;
  actorId?: string;
  reason?: string;
}

export async function recordExchangeRateSnapshot(
  tx: TenantDb,
  input: RecordSnapshotInput,
): Promise<{ id: string }> {
  const rows = await tx
    .insert(exchangeRateSnapshots)
    .values({
      baseCurrency: input.baseCurrency,
      quoteCurrency: input.quoteCurrency,
      rate: input.rate,
      effectiveAt: input.effectiveAt,
      source: input.source,
      providerName: input.providerName,
      ...(input.providerReference ? { providerReference: input.providerReference } : {}),
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    })
    .returning({ id: exchangeRateSnapshots.id });
  const row = rows[0];
  if (!row) throw new Error('recordExchangeRateSnapshot: insert returned no row');
  return row;
}

export async function exchangeRateSnapshotById(tx: TenantDb, id: string) {
  const rows = await tx
    .select()
    .from(exchangeRateSnapshots)
    .where(eq(exchangeRateSnapshots.id, id))
    .limit(1);
  return rows[0] ?? null;
}
