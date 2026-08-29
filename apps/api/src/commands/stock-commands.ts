/**
 * The inventory command (spec §25, Appendix D; PR-027): `AdjustInventory`.
 *
 * The one command in the chat handler whose risk tier DEPENDS on the
 * numbers: adding stock is STANDARD, but a delta that writes stock OFF is
 * Appendix D.2's "destructive inventory adjustment" and demands the full
 * HIGH_RISK machinery — a confirmation opened when the merchant was shown
 * the consequence, claimed by the same bus call that executes. The ingress
 * decides `destructive` from the gate's arithmetic and passes it as risk
 * context; context can only ever RAISE a tier, so a caller that forgets it
 * gets STANDARD for an addition and nothing worse.
 */
import { outboxRepo, stockRepo, type TenantDb } from '@rekoda/db';

export interface AdjustInventoryInput {
  businessId: string;
  productId: string;
  /** Signed. Negative is stock written off, and the caller marked it so. */
  delta: number;
  sourceType: string;
  sourceId: string | null;
}

export async function adjustInventoryWork(
  tx: TenantDb,
  input: AdjustInventoryInput,
): Promise<{ productId: string; delta: number }> {
  await stockRepo.recordMovement(tx, {
    businessId: input.businessId,
    productId: input.productId,
    delta: input.delta,
    reason: 'adjustment',
    sourceType: input.sourceType,
    sourceId: input.sourceId,
  });

  await outboxRepo.append(tx, {
    businessId: input.businessId,
    type: 'inventory.adjusted',
    payload: { productId: input.productId, delta: input.delta, sourceType: input.sourceType },
  });

  return { productId: input.productId, delta: input.delta };
}
