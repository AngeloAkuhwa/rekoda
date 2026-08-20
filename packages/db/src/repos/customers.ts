/**
 * Customer identity storage (spec §5–8, ADR 0005).
 *
 * SQL and transaction boundaries only. No crypto: this file never sees a
 * plaintext name or a vault key, and could not decrypt a row if it wanted to.
 * The ciphertext and the match key arrive already computed, which is what lets
 * the vault live in `@rekoda/core` as pure, testable functions.
 *
 * Both tables are under row-level security, so every read and write here goes
 * through a tenant pin.
 */
import { and, eq } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { withBusiness } from '../client.js';
import { customerIdentities, customers } from '../schema/privacy.js';

export type Queryable = Db | TenantDb;

export interface CustomerRow {
  id: string;
  token: string;
}

export interface IdentityInput {
  facet: 'name' | 'phone' | 'email' | 'address';
  /** AES-256-GCM blob from `@rekoda/core/vault`. */
  ciphertext: string;
  /** Keyed HMAC from `@rekoda/core/vault`. Null for facets never matched on. */
  matchKey: string | null;
}

/** The customer this match key belongs to, if this business has seen them. */
export async function findCustomerByMatchKey(
  db: Db,
  businessId: string,
  facet: IdentityInput['facet'],
  matchKey: string,
): Promise<CustomerRow | null> {
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx
      .select({ id: customers.id, token: customers.token })
      .from(customerIdentities)
      .innerJoin(customers, eq(customers.id, customerIdentities.customerId))
      .where(
        and(
          eq(customerIdentities.businessId, businessId),
          eq(customerIdentities.facet, facet),
          eq(customerIdentities.matchKey, matchKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export class TokenCollision extends Error {}

/**
 * Another transaction created this identity first.
 *
 * Not an error the caller should surface — it means the customer now exists
 * and the right response is to look them up. Distinct from `TokenCollision`,
 * which means "try a different token for the SAME new customer"; here the
 * customer is not new any more.
 */
export class IdentityConflict extends Error {}

/**
 * Create a customer and its first identity facets in one transaction.
 *
 * The token is supplied rather than generated here, because generating it
 * needs randomness and this layer has none by design. Uniqueness is enforced
 * by the database — `customers_business_token_ux` — and a collision surfaces
 * as `TokenCollision` for the caller to retry with a fresh token. Three
 * base32 characters is 32,768 per business, so a collision is rare and a
 * retry is cheaper than a longer token on every preview message.
 */
export async function createCustomerWithIdentities(
  db: Db,
  businessId: string,
  token: string,
  identities: readonly IdentityInput[],
): Promise<CustomerRow> {
  return withBusiness(db, businessId, async (tx) => {
    let customer: CustomerRow;
    try {
      const rows = await tx.insert(customers).values({ businessId, token }).returning({
        id: customers.id,
        token: customers.token,
      });
      const row = rows[0];
      if (!row) throw new Error('createCustomerWithIdentities: insert returned no row');
      customer = row;
    } catch (error) {
      if (isUniqueViolation(error)) throw new TokenCollision(`token ${token} is already in use`);
      throw error;
    }

    if (identities.length > 0) {
      try {
        await tx.insert(customerIdentities).values(
          identities.map((identity) => ({
            businessId,
            customerId: customer.id,
            facet: identity.facet,
            ciphertext: identity.ciphertext,
            matchKey: identity.matchKey,
          })),
        );
      } catch (error) {
        /**
         * `identities_match_ux` (migration 0005) rejected it: someone else got
         * there first. Throwing rolls back the customer row inserted above
         * too — which is exactly right, because it would otherwise be a
         * customer with no way to recognise them.
         */
        if (isUniqueViolation(error)) {
          throw new IdentityConflict('this identity already belongs to a customer');
        }
        throw error;
      }
    }
    return customer;
  });
}

/** Add a facet to a customer we already know — a phone for a name, say. */
export async function addIdentityFacet(
  db: Db,
  businessId: string,
  customerId: string,
  identity: IdentityInput,
): Promise<void> {
  await withBusiness(db, businessId, async (tx) => {
    await tx.insert(customerIdentities).values({
      businessId,
      customerId,
      facet: identity.facet,
      ciphertext: identity.ciphertext,
      matchKey: identity.matchKey,
    });
  });
}

/**
 * Facet rows inside a transaction the caller already holds — for callers that
 * are mid-pin and must not acquire a second pooled connection.
 */
export async function identityFacetsFor(
  tx: TenantDb,
  businessId: string,
  customerId: string,
): Promise<Array<{ facet: string; ciphertext: string }>> {
  return tx
    .select({ facet: customerIdentities.facet, ciphertext: customerIdentities.ciphertext })
    .from(customerIdentities)
    .where(
      and(
        eq(customerIdentities.businessId, businessId),
        eq(customerIdentities.customerId, customerId),
      ),
    );
}

/** Every stored facet for one customer, for the authorised output layer only. */
export async function identitiesForCustomer(
  db: Db,
  businessId: string,
  customerId: string,
): Promise<Array<{ facet: string; ciphertext: string }>> {
  return withBusiness(db, businessId, async (tx) => {
    return tx
      .select({ facet: customerIdentities.facet, ciphertext: customerIdentities.ciphertext })
      .from(customerIdentities)
      .where(
        and(
          eq(customerIdentities.businessId, businessId),
          eq(customerIdentities.customerId, customerId),
        ),
      );
  });
}

/**
 * Erase one facet — the reason identities are stored one row per facet rather
 * than as a single blob. "Forget my address but keep the invoices" has to be
 * possible without rewriting the financial record (see /data-deletion).
 */
export async function eraseFacet(
  db: Db,
  businessId: string,
  customerId: string,
  facet: IdentityInput['facet'],
): Promise<number> {
  return withBusiness(db, businessId, async (tx) => {
    const deleted = await tx
      .delete(customerIdentities)
      .where(
        and(
          eq(customerIdentities.businessId, businessId),
          eq(customerIdentities.customerId, customerId),
          eq(customerIdentities.facet, facet),
        ),
      )
      .returning({ id: customerIdentities.id });
    return deleted.length;
  });
}

/** PostgreSQL unique-violation, wrapped by drizzle 0.45 under `.cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      (e as { code?: string }).code === '23505'
    ) {
      return true;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The chat erasure command: every identity facet of every customer, gone in
 * one statement. The customers rows stay — they hold only the CUSTOMER_x
 * token, which after this deletion resolves to nobody. Financial records
 * keep their reference numbers and nothing else.
 */
export async function eraseAllIdentities(tx: TenantDb, businessId: string): Promise<number> {
  const deleted = await tx
    .delete(customerIdentities)
    .where(eq(customerIdentities.businessId, businessId))
    .returning({ id: customerIdentities.id });
  return deleted.length;
}
