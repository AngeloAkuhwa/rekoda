/**
 * Supplier records, vaulted (the "later slice" spend.ts promised).
 *
 * The same construction as customers, smaller: one facet (the name), one
 * cipher this package cannot open, one HMAC fold the database deduplicates
 * on. No token, because no supplier is ever addressed in a message — the
 * id is reference enough for the books.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { TenantDb } from '../client.js';
import { suppliers } from '../schema/commerce.js';

/** Two drafts named the same supplier at once; the database picked one. */
class MatchRace extends Error {}

export async function findOrCreateSupplier(
  tx: TenantDb,
  businessId: string,
  identity: { nameCipher: string; matchKey: string },
): Promise<{ supplierId: string; created: boolean }> {
  const existing = await tx
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(and(eq(suppliers.businessId, businessId), eq(suppliers.matchKey, identity.matchKey)))
    .limit(1);
  if (existing[0]) return { supplierId: existing[0].id, created: false };

  try {
    const rows = await tx
      .insert(suppliers)
      .values({
        businessId,
        nameCipher: identity.nameCipher,
        matchKey: identity.matchKey,
      })
      .returning({ id: suppliers.id });
    const row = rows[0];
    if (!row) throw new Error('findOrCreateSupplier: insert returned no row');
    return { supplierId: row.id, created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      /* Lost the race: the winner IS this supplier. */
      const winner = await tx
        .select({ id: suppliers.id })
        .from(suppliers)
        .where(and(eq(suppliers.businessId, businessId), eq(suppliers.matchKey, identity.matchKey)))
        .limit(1);
      if (winner[0]) return { supplierId: winner[0].id, created: false };
      throw new MatchRace('supplier match race with no winner');
    }
    throw error;
  }
}

/** Ciphers by id, for the authorised boundary to open. Never plaintext. */
export async function supplierCiphersFor(
  tx: TenantDb,
  businessId: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await tx
    .select({ id: suppliers.id, nameCipher: suppliers.nameCipher })
    .from(suppliers)
    .where(and(eq(suppliers.businessId, businessId), inArray(suppliers.id, ids)));
  return new Map(rows.map((row) => [row.id, row.nameCipher]));
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
