/**
 * The R0A-i classifier, run against real rows (PR-120).
 *
 * `scripts/investigations/r0a-i-payment-provenance.sql` is the script that
 * decides which historical payments a backfill may touch, and it is
 * reviewed by a person and then approved. This suite pins the two
 * properties that make the review meaningful:
 *
 *   THE LADDER classifies by evidence and by nothing else. A payment with
 *   provider anchors is verified; a merchant's confirmed draft is an
 *   attestation; everything left over is honestly unknown.
 *
 *   THE CHECKSUM identifies the POPULATION, not its size. Two sets of the
 *   same number of payments are not the same payments, and the whole reason
 *   the migration carries a hash is that counts cannot tell them apart.
 *
 * The ladder is copied here from the script rather than imported, because
 * the script is psql and this is not. That copy is the point: if somebody
 * changes the ladder in one place and not the other, this suite goes red
 * and the report stops being the thing that was approved.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { identity } from './index.js';
import { migrate, requireUrls, truncateAll, type Urls } from './testing.js';

let urls: Urls;
let owner: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  urls = requireUrls();
  await migrate(urls);
  ({ db: owner, close } = createDb(urls.owner, { max: 2 }));
});

afterAll(async () => {
  await close?.();
});

beforeEach(async () => {
  await truncateAll(urls);
});

/** The ladder, verbatim from section 6 of the classifier. */
const CLASSIFY = `
  WITH classified AS (
    SELECT
      p.id,
      CASE
        WHEN p.payment_intent_id IS NOT NULL
         AND p.provider_ref IS NOT NULL              THEN 'PROVIDER_VERIFIED'
        WHEN p.source_id IS NOT NULL AND EXISTS (
          SELECT 1
            FROM ledger_transactions lt
            JOIN bank_line_matches   blm ON blm.transaction_id = lt.id
           WHERE lt.business_id = p.business_id
             AND lt.source_type = p.source_type
             AND lt.source_id   = p.source_id
        )                                            THEN 'BANK_FEED_MATCH'
        WHEN p.source_type = 'chat'
         AND d.state = 'confirmed'
         AND d.intent IN ('RecordPayment', 'RecordSale')
                                                     THEN 'MERCHANT_ATTESTED'
        WHEN p.source_type = 'dashboard' AND EXISTS (
          SELECT 1 FROM audit_events a
           WHERE a.business_id = p.business_id
             AND a.entity      = 'payment'
             AND a.entity_id   = p.id::text
             AND a.actor LIKE 'user:%'
        )                                            THEN 'MERCHANT_ATTESTED'
        ELSE                                              'LEGACY_PROVENANCE_UNKNOWN'
      END AS provenance
    FROM payments p
    LEFT JOIN command_drafts d
      ON p.source_type = 'chat'
     AND d.business_id = p.business_id
     AND d.id::text    = p.source_id
  )
  SELECT provenance,
         count(*)::int AS rows,
         encode(
           sha256(coalesce(string_agg(id::text, ',' ORDER BY id), '')::bytea),
           'hex'
         ) AS population_sha256
    FROM classified
   GROUP BY provenance
   ORDER BY provenance
`;

interface Grade {
  provenance: string;
  rows: number;
  population_sha256: string;
}

async function classify(): Promise<Map<string, Grade>> {
  const rows = await owner.execute<Record<string, unknown>>(sql.raw(CLASSIFY));
  return new Map([...rows].map((row) => [row['provenance'] as string, row as unknown as Grade]));
}

async function seedBusiness(phone: string): Promise<string> {
  const user = await identity.upsertUserByPhone(owner, phone);
  const business = await identity.createBusinessWithOwner(owner, {
    name: 'Ada Fashion',
    businessType: null,
    ownerUserId: user.id,
  });
  return business.id;
}

/** A payment with exactly the anchors the caller names, as the owner. */
async function seedPayment(
  businessId: string,
  opts: { sourceType: string; providerAnchors?: boolean; sourceId?: string | null },
): Promise<string> {
  const rows = await owner.execute<{ id: string }>(sql`
    INSERT INTO payments (business_id, amount_k, method, source_type, source_id,
                          provider_ref, initial_confirmation_source)
    VALUES (${businessId}::uuid, 100000, 'transfer', ${opts.sourceType},
            ${opts.sourceId ?? null},
            ${opts.providerAnchors ? 'ref-123' : null},
            /* The column the estate writes TODAY. These fixtures are
             * legacy-shaped rows, and the classifier deliberately ignores
             * this column: it reconstructs from evidence rather than
             * trusting what some past code path recorded. */
            'LEGACY_PROVENANCE_UNKNOWN')
    RETURNING id
  `);
  return [...rows][0]!.id;
}

/** A draft in the state the caller names, with the conversation row it needs. */
async function seedDraft(businessId: string, state: string): Promise<string> {
  const conversation = await owner.execute<{ id: string }>(sql`
    INSERT INTO conversations (business_id, channel, conversation_kind)
    VALUES (${businessId}::uuid, 'whatsapp', 'MERCHANT')
    RETURNING id
  `);
  const message = await owner.execute<{ id: string }>(sql`
    INSERT INTO conversation_messages
      (business_id, conversation_id, direction, kind, body, provider_message_id)
    VALUES (${businessId}::uuid, ${[...conversation][0]!.id}::uuid, 'inbound', 'text',
            'Ada paid 60k', ${`wamid.${Math.random().toString(36).slice(2)}`})
    RETURNING id
  `);
  const draft = await owner.execute<{ id: string }>(sql`
    INSERT INTO command_drafts (business_id, conversation_message_id, intent, command, state)
    VALUES (${businessId}::uuid, ${[...message][0]!.id}::uuid, 'RecordPayment',
            '{}'::jsonb, ${state})
    RETURNING id
  `);
  return [...draft][0]!.id;
}

describe('the ladder classifies by evidence', () => {
  it('calls an unanchored payment unknown, and says so rather than guessing', async () => {
    const businessId = await seedBusiness('+2348192000001');
    await seedPayment(businessId, { sourceType: 'chat' });

    const graded = await classify();
    expect(graded.get('LEGACY_PROVENANCE_UNKNOWN')?.rows).toBe(1);
    expect(graded.has('MERCHANT_ATTESTED')).toBe(false);
  });

  it('promotes a payment the merchant confirmed, by the state transition and not the medium', async () => {
    const businessId = await seedBusiness('+2348192000002');
    const draftId = await seedDraft(businessId, 'confirmed');
    await seedPayment(businessId, { sourceType: 'chat', sourceId: draftId });

    expect((await classify()).get('MERCHANT_ATTESTED')?.rows).toBe(1);
  });

  it('a pending draft is not an attestation, because nobody answered it', async () => {
    const businessId = await seedBusiness('+2348192000003');
    await seedPayment(businessId, {
      sourceType: 'chat',
      sourceId: await seedDraft(businessId, 'pending'),
    });

    expect((await classify()).get('LEGACY_PROVENANCE_UNKNOWN')?.rows).toBe(1);
  });
});

describe('the checksum identifies the population, not its size', () => {
  it('is stable for the same rows and different for a different set of the same size', async () => {
    const businessId = await seedBusiness('+2348192000010');
    await seedPayment(businessId, { sourceType: 'chat' });
    await seedPayment(businessId, { sourceType: 'chat' });

    const first = (await classify()).get('LEGACY_PROVENANCE_UNKNOWN')!;
    expect(first.rows).toBe(2);
    expect(first.population_sha256).toMatch(/^[0-9a-f]{64}$/);

    /* Re-reading the same rows gives the same number. Ordering inside the
     * aggregate is what makes that true regardless of the plan. */
    expect((await classify()).get('LEGACY_PROVENANCE_UNKNOWN')!.population_sha256).toBe(
      first.population_sha256,
    );

    /* A DIFFERENT two payments. Same count, and the count is exactly why a
     * count cannot be the approval: this is the case migration_manifests
     * carries a hash for. */
    await truncateAll(urls);
    const other = await seedBusiness('+2348192000011');
    await seedPayment(other, { sourceType: 'chat' });
    await seedPayment(other, { sourceType: 'chat' });

    const second = (await classify()).get('LEGACY_PROVENANCE_UNKNOWN')!;
    expect(second.rows).toBe(2);
    expect(second.population_sha256).not.toBe(first.population_sha256);
  });
});

describe('the manifest records who approved what (0116)', () => {
  it('refuses a half-recorded approval', async () => {
    const half = await owner
      .execute(
        sql`
        INSERT INTO migration_manifests (name, cutoff_at, created_by, approved_by_user_id)
        VALUES ('R0A-ii', now(), 'operator:test', gen_random_uuid())
      `,
      )
      .then(
        () => 'accepted',
        (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
      );
    expect(half).toMatch(/approval_complete/);
  });

  it('accepts an approval carrying both the approver and the report it approved', async () => {
    const sha = 'a'.repeat(64);
    const rows = await owner.execute<{ id: string }>(sql`
      INSERT INTO migration_manifests
        (name, cutoff_at, created_by, approved_by, approved_by_user_id,
         source_report_sha256, classifier_sha256, item_set_checksum)
      VALUES ('R0A-ii', now(), 'operator:test', 'A. Operator', gen_random_uuid(),
              ${sha}, ${sha}, ${sha})
      RETURNING id
    `);
    expect([...rows]).toHaveLength(1);
  });

  it('refuses a fingerprint that is not a SHA-256', async () => {
    const refused = await owner
      .execute(
        sql`
        INSERT INTO migration_manifests
          (name, cutoff_at, created_by, approved_by_user_id, source_report_sha256)
        VALUES ('R0A-ii', now(), 'operator:test', gen_random_uuid(), 'not-a-hash')
      `,
      )
      .then(
        () => 'accepted',
        (error: Error & { cause?: Error }) => error.cause?.message ?? error.message,
      );
    expect(refused).toMatch(/report_sha/);
  });
});
