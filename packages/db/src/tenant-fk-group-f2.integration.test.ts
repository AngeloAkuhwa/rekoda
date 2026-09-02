/**
 * The tenant-composite foreign keys, group F part two: the evidence chain.
 *
 * Five of the fourteen relationships that re-running the R1 audit's own
 * question against the finished schema turned up (part one was 0141). They
 * are the provenance spine behind verify-before-book, and they run two deep:
 * evidence carries payments, verifications and legal holds; a verification in
 * turn carries its claims and its revocations.
 *
 * What each weak edge allowed is worth naming, because none of it is abstract:
 * a payment booked against another merchant's evidence, a verification
 * vouching for it, a legal hold pinning another merchant's document past its
 * retention date, and a revocation withdrawing another merchant's finding.
 *
 * Run on the OWNER credential and outside row-level security, for the reason
 * the earlier groups give: RLS would refuse the cross-tenant write on its own,
 * so these tests would pass with no foreign keys at all.
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
  const created = createDb(urls.owner, { max: 2 });
  owner = created.db;
  close = created.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await truncateAll(urls);
});

interface Edge {
  readonly edge: string;
  readonly child: string;
  readonly column: string;
  readonly parent: string;
  readonly constraint: string;
}

const GROUP_F2: readonly Edge[] = [
  {
    edge: 'payments.payment_evidence_id -> payment_evidence',
    child: 'payments',
    column: 'payment_evidence_id',
    parent: 'payment_evidence',
    constraint: 'payments_evidence_business_fk',
  },
  {
    edge: 'payment_verifications.payment_evidence_id -> payment_evidence',
    child: 'payment_verifications',
    column: 'payment_evidence_id',
    parent: 'payment_evidence',
    constraint: 'payment_verifications_evidence_business_fk',
  },
  {
    edge: 'evidence_legal_holds.payment_evidence_id -> payment_evidence',
    child: 'evidence_legal_holds',
    column: 'payment_evidence_id',
    parent: 'payment_evidence',
    constraint: 'evidence_legal_holds_evidence_business_fk',
  },
  {
    edge: 'payment_verification_claims.verification_id -> payment_verifications',
    child: 'payment_verification_claims',
    column: 'verification_id',
    parent: 'payment_verifications',
    constraint: 'payment_verification_claims_verification_business_fk',
  },
  {
    edge: 'payment_verification_revocations.verification_id -> payment_verifications',
    child: 'payment_verification_revocations',
    column: 'verification_id',
    parent: 'payment_verifications',
    constraint: 'payment_verification_revocations_verification_business_fk',
  },
];

/** The parents that had to gain a tenant key before the edges could point at them. */
const NEW_UNIQUES = [
  { label: 'payment_evidence', table: 'payment_evidence', name: 'payment_evidence_business_id_ux' },
  {
    label: 'payment_verifications',
    table: 'payment_verifications',
    name: 'payment_verifications_business_id_ux',
  },
] as const;

describe('group F2: the keys are declared as ruling 1 asked', () => {
  it.each(GROUP_F2)(
    '$edge: a validated composite key',
    async ({ child, column, parent, constraint }) => {
      const rows = await owner.execute<{ def: string; validated: boolean }>(sql`
        SELECT pg_get_constraintdef(con.oid) AS def, con.convalidated AS validated
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
         WHERE c.relname = ${child} AND con.conname = ${constraint}
      `);
      const row = [...rows][0];
      expect(row?.def).toBe(
        `FOREIGN KEY (business_id, ${column}) REFERENCES ${parent}(business_id, id)`,
      );
      expect(row?.validated).toBe(true);
    },
  );

  it.each(GROUP_F2)('$edge: the weaker single-column key is gone', async ({ child, column }) => {
    const rows = await owner.execute<{ conname: string }>(sql`
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1
         AND c.relname = ${child} AND a.attname = ${column}
    `);
    expect([...rows].map((r) => r.conname)).toEqual([]);
  });

  it.each(NEW_UNIQUES)(
    '$label gains the tenant key the edges point at',
    async ({ table, name }) => {
      const rows = await owner.execute<{ def: string }>(sql`
      SELECT pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
       WHERE c.relname = ${table} AND con.conname = ${name}
    `);
      expect([...rows][0]?.def).toBe('UNIQUE (business_id, id)');
    },
  );

  it('keeps the two evidence references nullable, which is what they mean', async () => {
    const rows = await owner.execute<{ col: string; notnull: boolean }>(sql`
      SELECT c.relname || '.' || a.attname AS col, a.attnotnull AS notnull
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
       WHERE a.attname = 'payment_evidence_id'
         AND c.relname IN ('payments', 'payment_verifications', 'evidence_legal_holds')
       ORDER BY 1
    `);

    /* Not every payment arrives with evidence, and a verification can rest on
     * something other than a document, so those two stay nullable and MATCH
     * SIMPLE skips them only when the evidence itself is absent. A legal hold
     * with no evidence would be meaningless, so that one is NOT NULL and is
     * always checked. Asserted so the distinction survives a later edit. */
    expect([...rows]).toEqual([
      { col: 'evidence_legal_holds.payment_evidence_id', notnull: true },
      { col: 'payment_verifications.payment_evidence_id', notnull: false },
      { col: 'payments.payment_evidence_id', notnull: false },
    ]);
  });
});

/** One merchant with the whole evidence chain, written raw. */
async function seedCast(tag: string): Promise<Record<string, string>> {
  const user = await identity.upsertUserByPhone(owner, `+23488${tag.padStart(8, '0')}`);
  const business = await identity.createBusinessWithOwner(owner, {
    name: `Evidence ${tag}`,
    businessType: null,
    ownerUserId: user.id,
  });
  const b = business.id;

  const one = async (statement: ReturnType<typeof sql>): Promise<string> => {
    const rows = await owner.execute<{ id: string }>(statement);
    const id = [...rows][0]?.id;
    if (!id) throw new Error('fixture insert returned no id');
    return id;
  };

  const evidence = await one(sql`
    INSERT INTO payment_evidence (business_id, source) VALUES (${b}::uuid, 'merchant_upload')
    RETURNING id`);
  const payment = await one(sql`
    INSERT INTO payments (business_id, amount_k, method, source_type, payment_evidence_id)
    VALUES (${b}::uuid, 1000, 'transfer', 'chat', ${evidence}::uuid) RETURNING id`);
  const verification = await one(sql`
    INSERT INTO payment_verifications (business_id, payment_id, source, payment_evidence_id)
    VALUES (${b}::uuid, ${payment}::uuid, 'MERCHANT_ATTESTED', ${evidence}::uuid) RETURNING id`);
  const hold = await one(sql`
    INSERT INTO evidence_legal_holds (business_id, payment_evidence_id, kind, reason, placed_by)
    VALUES (${b}::uuid, ${evidence}::uuid, 'dispute', 'fixture hold', 'ops') RETURNING id`);
  /* Exactly one of financial_transaction_id, provider_source_identity or
   * confirmation_event_id, per the table's own CHECK. */
  const claim = await one(sql`
    INSERT INTO payment_verification_claims (business_id, verification_id, provider_source_identity)
    VALUES (${b}::uuid, ${verification}::uuid, ${`src-${tag}`}) RETURNING id`);
  const revocation = await one(sql`
    INSERT INTO payment_verification_revocations (business_id, verification_id, reason, actor_id)
    VALUES (${b}::uuid, ${verification}::uuid, 'fixture revocation', 'ops') RETURNING id`);
  /* A second verification carrying neither a claim nor a revocation.
   * `payment_verification_claims_per_verification` and
   * `payment_verification_revocations_once` each allow one row per
   * verification, so aiming the cross-tenant UPDATE at a verification that
   * already has its own would trip THAT unique first and prove nothing about
   * the tenant. This is the verification the edge tests point at. */
  const spare = await one(sql`
    INSERT INTO payment_verifications (business_id, payment_id, source, payment_evidence_id)
    VALUES (${b}::uuid, ${payment}::uuid, 'PROVIDER_VERIFIED', ${evidence}::uuid) RETURNING id`);

  return {
    businesses: b,
    payment_evidence: evidence,
    payments: payment,
    payment_verifications: spare,
    evidence_legal_holds: hold,
    payment_verification_claims: claim,
    payment_verification_revocations: revocation,
  };
}

describe('group F2: the refusal is the database’s, not the application’s', () => {
  it.each(GROUP_F2)(
    '$edge: cannot be repointed at another tenant’s row',
    async ({ child, column, parent, constraint }) => {
      const mine = await seedCast('1');
      const theirs = await seedCast('2');

      /* Same tenant first: a constraint that refused everything would pass the
       * cross-tenant case and prove nothing. */
      await expect(
        owner.execute(
          sql.raw(`UPDATE ${child} SET ${column} = '${mine[parent]}' WHERE id = '${mine[child]}'`),
        ),
      ).resolves.toBeDefined();

      const refusal = await owner
        .execute(
          sql.raw(
            `UPDATE ${child} SET ${column} = '${theirs[parent]}' WHERE id = '${mine[child]}'`,
          ),
        )
        .then(
          () => null,
          (error: Error & { cause?: unknown }) => error,
        );

      expect(refusal, `${child}.${column} accepted another tenant's ${parent}`).not.toBeNull();
      expect(String(refusal?.cause)).toContain(constraint);
    },
  );

  it('a legal hold cannot pin another tenant’s document past its retention date', async () => {
    const mine = await seedCast('3');
    const theirs = await seedCast('4');

    /* The retention sweep reads holds to decide what it may not purge. A hold
     * owned by me but naming another merchant's evidence would keep THEIR
     * document alive past the schedule /privacy publishes, under a reason they
     * never gave. Same edge as above, said in the terms that matter. */
    const refusal = await owner
      .execute(
        sql.raw(`INSERT INTO evidence_legal_holds
                   (business_id, payment_evidence_id, kind, reason, placed_by)
                 VALUES ('${mine['businesses']}', '${theirs['payment_evidence']}',
                         'tax_audit', 'cross tenant hold', 'ops')`),
      )
      .then(
        () => null,
        (error: Error & { cause?: unknown }) => error,
      );

    expect(refusal, "accepted a hold on another tenant's evidence").not.toBeNull();
    expect(String(refusal?.cause)).toContain('evidence_legal_holds_evidence_business_fk');
  });

  it('a payment keeps its right to have no evidence at all', async () => {
    const mine = await seedCast('5');

    /* The nullable half of the rule. Booking a payment with no evidence is a
     * legitimate shape and must stay legitimate; only naming SOMEONE ELSE'S
     * evidence is refused. */
    await expect(
      owner.execute(
        sql.raw(`UPDATE payments SET payment_evidence_id = NULL
                  WHERE id = '${mine['payments']}'`),
      ),
    ).resolves.toBeDefined();
  });
});
