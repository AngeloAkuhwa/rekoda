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
import { and, eq, sql, inArray } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';
import { withBusiness } from '../client.js';
import { customerIdentities, customers } from '../schema/privacy.js';
import { auditEvents } from '../schema/ops.js';

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

/** A customer name found by its keyed hash, for the gateway's known-name pass. */
export interface NameByKey {
  matchKey: string;
  token: string;
  customerId: string;
}

/**
 * The customers whose stored NAME hashes to one of these keys.
 *
 * The privacy gateway extracts candidate word-groups from an inbound message,
 * folds and hashes each with the business's match key, and asks this in ONE
 * query. That makes the known-name pass complete for any customer count and
 * bounded by the message length, not the customer table: it reads only the
 * few names actually mentioned, straight off `identities_match_ix`
 * (business_id, facet, match_key), and never decrypts a name to find it.
 */
export async function namesByMatchKeys(
  db: Db,
  businessId: string,
  matchKeys: readonly string[],
): Promise<NameByKey[]> {
  if (matchKeys.length === 0) return [];
  return withBusiness(db, businessId, async (tx) => {
    const rows = await tx
      .select({
        matchKey: customerIdentities.matchKey,
        token: customers.token,
        customerId: customers.id,
      })
      .from(customerIdentities)
      .innerJoin(customers, eq(customers.id, customerIdentities.customerId))
      .where(
        and(
          eq(customerIdentities.businessId, businessId),
          eq(customerIdentities.facet, 'name'),
          inArray(customerIdentities.matchKey, [...matchKeys]),
        ),
      );
    return rows
      .filter(
        (r): r is { matchKey: string; token: string; customerId: string } => r.matchKey !== null,
      )
      .map((r) => ({ matchKey: r.matchKey, token: r.token, customerId: r.customerId }));
  });
}

export class TokenCollision extends Error {}

/**
 * This identity already belongs to a customer (`identities_match_ux`).
 *
 * Creating a customer, it means another transaction created this very person
 * first, and the right response is to look them up. Adding a facet, it means
 * the facet keys ANOTHER customer, and the two records stay apart: a typed
 * name is never a reason to merge two people (G-60). Distinct from
 * `TokenCollision`, which means "try a different token for the SAME new
 * customer". It carries no identity value, ciphertext or key.
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
/**
 * The customer a token stands for.
 *
 * Chat-issued invoices carried `customer_id = NULL` and kept the token in
 * `snapshot_json`, which was enough for matching a payment to an invoice
 * (see `openInvoiceForPayment`) and not enough for anything that needs the
 * PERSON: minting a payment link reads their email off the identity vault,
 * and there is no vault to read without a customer row to hang it on. The
 * privacy gateway has always resolved one; the sale simply threw it away.
 *
 * Null for a token nobody has seen, which is not an error: a merchant can
 * name somebody the gateway has never tokenised.
 */
/** The inverse read: the pseudonymous token a customer row carries. */
export async function tokenForCustomer(
  tx: TenantDb,
  businessId: string,
  customerId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ token: customers.token })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, customerId)))
    .limit(1);
  return rows[0]?.token ?? null;
}

export async function customerIdForToken(
  tx: TenantDb,
  businessId: string,
  token: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: customers.id })
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.token, token)))
    .limit(1);
  return rows[0]?.id ?? null;
}

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

/**
 * A facet could not be attached for a reason that is not a conflict (G-60):
 * a customer that does not exist, another tenant's customer, an outage.
 * Carries PostgreSQL's reason and its SQLSTATE `code`, never the statement,
 * its bound values (the facet's ciphertext and match key) or a `cause` that
 * would carry them.
 */
export class IdentityFacetWriteFailed extends Error {
  readonly code: string | null;
  constructor(reason: string, code: string | null) {
    super(`could not attach an identity facet: ${reason}`);
    this.name = 'IdentityFacetWriteFailed';
    this.code = code;
  }
}

/** Attempts when the holder of a taken facet keeps vanishing before it is read. */
const ATTACH_ATTEMPTS = 3;

/**
 * Add a facet to a customer we already know — a phone for a name, say.
 *
 * The contract (G-60): `'attached'`, or `'already-attached'` when this
 * customer already holds the facet; an `IdentityConflict` only when the facet
 * ACTUALLY keys another customer of this business, decided by
 * `identities_match_ux`, so two racing attachments still leave one owner.
 * When the holder is erased between the conflict and the read of who holds
 * it, the facet is free and the attachment is tried again, a bounded number
 * of times. Any other failure is an `IdentityFacetWriteFailed`.
 */
export async function addIdentityFacet(
  db: Db,
  businessId: string,
  customerId: string,
  identity: IdentityInput,
): Promise<'attached' | 'already-attached'> {
  for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
    try {
      await withBusiness(db, businessId, async (tx) => {
        await tx.insert(customerIdentities).values({
          businessId,
          customerId,
          facet: identity.facet,
          ciphertext: identity.ciphertext,
          matchKey: identity.matchKey,
        });
      });
      return 'attached';
    } catch (error) {
      if (violatedConstraint(error) !== 'identities_match_ux' || identity.matchKey === null) {
        throw writeFailed(error);
      }
    }
    /* The insert rolled back; who holds the facet is read in its own
     * transaction. Unique on (business, facet, key), so there is one owner. */
    const owner = await findCustomerByMatchKey(
      db,
      businessId,
      identity.facet,
      identity.matchKey,
    ).catch((error: unknown) => {
      throw writeFailed(error);
    });
    if (owner === null) continue;
    if (owner.id === customerId) return 'already-attached';
    throw new IdentityConflict('this identity already belongs to another customer');
  }
  throw new IdentityFacetWriteFailed('its holder kept changing; try again', null);
}

/** A database failure as an `IdentityFacetWriteFailed`: reason and code only. */
function writeFailed(error: unknown): IdentityFacetWriteFailed {
  return new IdentityFacetWriteFailed(databaseReason(error), databaseCode(error));
}

/** The SQLSTATE PostgreSQL gave, wherever drizzle wrapped it. */
function databaseCode(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
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

/** What PostgreSQL said, skipping drizzle's "Failed query: <sql> params: …" wrapper. */
function databaseReason(error: unknown): string {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const message = e instanceof Error ? e.message : String(e);
    if (!message.startsWith('Failed query:')) return message;
    e = (e as { cause?: unknown }).cause;
  }
  return 'unknown database error';
}

/** Which unique constraint rejected a write, when PostgreSQL says. */
function violatedConstraint(error: unknown): string | null {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    if (typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505') {
      return (e as { constraint_name?: string }).constraint_name ?? null;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
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
 *
 * Audited in the same transaction, like every other privileged mutation in
 * this codebase. An irreversible NDPR deletion that left no trace would be
 * the one place a merchant could not answer "when did this happen and who
 * asked for it" — including to a regulator asking on their customer's
 * behalf. Counts only: an audit row that preserved what was erased would
 * defeat the erasure.
 */
export async function eraseAllIdentities(
  tx: TenantDb,
  businessId: string,
  sourceType: string,
): Promise<number> {
  const deleted = await tx
    .delete(customerIdentities)
    .where(eq(customerIdentities.businessId, businessId))
    .returning({ id: customerIdentities.id });

  await tx.insert(auditEvents).values({
    businessId,
    actor: 'system',
    entity: 'customer_identities',
    entityId: null,
    action: 'erased',
    newValue: { facetsDeleted: deleted.length },
    reason: 'the merchant asked for erasure',
    sourceType,
  });

  return deleted.length;
}

/**
 * Join two customer records the merchant has confirmed are one person.
 *
 * The orphan's identity facets move onto the survivor and the orphan row goes.
 * An UPDATE rather than a delete-and-reinsert, so the ciphertext is never
 * decrypted to be moved: the vault is not opened by a merge.
 *
 * REFUSES when the orphan has any history. A record with invoices, payments
 * or orders against it needs those moved too, and moving a merchant's
 * financial history is not something a `yes` in a chat should trigger. This
 * only ever joins a record created moments ago in the same message, which is
 * the split it exists to undo.
 *
 * Returns false when the merge was refused or either record has gone, which
 * the caller reports plainly rather than retrying: neither is transient.
 */
export async function linkCustomers(
  tx: TenantDb,
  businessId: string,
  survivorId: string,
  orphanId: string,
): Promise<boolean> {
  if (survivorId === orphanId) return false;

  const rows = await tx.execute<{ history: number }>(sql`
    SELECT (
      (SELECT count(*) FROM invoices WHERE business_id = ${businessId}::uuid AND customer_id = ${orphanId}::uuid)
      + (SELECT count(*) FROM payments WHERE business_id = ${businessId}::uuid AND customer_id = ${orphanId}::uuid)
      + (SELECT count(*) FROM orders WHERE business_id = ${businessId}::uuid AND customer_id = ${orphanId}::uuid)
      + (SELECT count(*) FROM payment_intents WHERE business_id = ${businessId}::uuid AND customer_id = ${orphanId}::uuid)
    )::int AS history
  `);
  if (Number([...rows][0]?.history ?? 1) > 0) return false;

  const survivor = await tx.execute<{ id: string }>(sql`
    SELECT id FROM customers WHERE business_id = ${businessId}::uuid AND id = ${survivorId}::uuid
  `);
  if ([...survivor].length !== 1) return false;

  await tx.execute(sql`
    UPDATE customer_identities SET customer_id = ${survivorId}::uuid
    WHERE business_id = ${businessId}::uuid AND customer_id = ${orphanId}::uuid
  `);
  const gone = await tx.execute<{ id: string }>(sql`
    DELETE FROM customers
    WHERE business_id = ${businessId}::uuid AND id = ${orphanId}::uuid
    RETURNING id
  `);
  return [...gone].length === 1;
}
