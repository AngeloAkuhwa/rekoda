/**
 * G-127 (OWN-90 §5.2; migration 0211): the settlement and billing-operator principals hold EXACTLY
 * the reviewed grants, no inherited role and no membership at all. Read from the catalogue
 * (`aclexplode` over table and column ACLs), so a later GRANT, a widened column list or a restored
 * membership fails here until the list below is changed in review. The live checks then prove the
 * stolen-credential consequence: neither principal can reach a tenant's ordinary records.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import {
  operatorDb,
  outcome,
  ownerDb,
  seedBusiness,
  settlementDb,
  usePlanWriterHarness,
} from './plan-writer.fixtures.js';

usePlanWriterHarness();

const CATALOGUE = [
  'add_on_grants SELECT',
  'add_ons SELECT',
  'allowance_versions SELECT',
  'entitlements SELECT',
  'plan_prices SELECT',
  'plan_version_entitlements SELECT',
  'plan_versions SELECT',
  'usage_packs SELECT',
];
const CYCLE_COLUMNS = [
  'billing_interval',
  'cycle_started_at',
  'ever_paid_at',
  'last_grace_reminder_day',
  'payment_failed_at',
  'pending_billing_interval',
  'pending_plan',
  'plan_decided_at',
  'plan_decided_before_pending',
  'plan_version_id',
  'renewal_anchor_day',
  'subscription_origin',
  'updated_at',
].map((c) => `businesses.${c} UPDATE`);

const EXPECTED: Record<string, { tables: string[]; columns: string[] }> = {
  rekoda_settlement: {
    tables: [
      ...CATALOGUE,
      'audit_events INSERT,SELECT',
      'business_add_ons INSERT,SELECT,UPDATE',
      'business_entitlements SELECT',
      'businesses SELECT',
      'dead_job_exceptions SELECT',
      'external_events SELECT',
      'jobs SELECT',
      'subscription_charge_attempts INSERT,SELECT,UPDATE',
      'subscription_charges INSERT,SELECT,UPDATE',
      'usage_counters SELECT',
    ].sort(),
    columns: [
      ...CYCLE_COLUMNS,
      'dead_job_exceptions.closed_at UPDATE',
      'dead_job_exceptions.closed_by UPDATE',
      'dead_job_exceptions.resolution UPDATE',
      'dead_job_exceptions.status UPDATE',
      'dead_job_exceptions.updated_at UPDATE',
      'external_events.error UPDATE',
      'external_events.processed_at UPDATE',
      'jobs.locked_at UPDATE',
      'jobs.locked_by UPDATE',
      'jobs.state UPDATE',
      'jobs.updated_at UPDATE',
    ].sort(),
  },
  rekoda_billing_operator: {
    tables: [
      ...CATALOGUE,
      'audit_events SELECT',
      'businesses SELECT',
      'subscription_charges SELECT',
    ].sort(),
    columns: [...CYCLE_COLUMNS].sort(),
  },
};

const grantsOf = async (role: string) => {
  const tables = [
    ...(await ownerDb.execute<{ g: string }>(sql`
      SELECT c.relname || ' ' || string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type) AS g
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE n.nspname = 'public' AND a.grantee = ${role}::regrole
      GROUP BY c.relname ORDER BY 1`)),
  ].map((r) => r.g);
  const columns = [
    ...(await ownerDb.execute<{ g: string }>(sql`
      SELECT c.relname || '.' || at.attname || ' '
             || string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type) AS g
      FROM pg_attribute at JOIN pg_class c ON c.oid = at.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(at.attacl) a
      WHERE n.nspname = 'public' AND a.grantee = ${role}::regrole
      GROUP BY c.relname, at.attname ORDER BY 1`)),
  ].map((r) => r.g);
  return { tables: tables.sort(), columns: columns.sort() };
};

describe('G-127: the settlement and billing-operator principals hold exactly the reviewed grants (0211)', () => {
  it.each(Object.keys(EXPECTED))(
    '%s: tables and columns are exactly the reviewed list',
    async (role) => {
      expect(await grantsOf(role)).toEqual(EXPECTED[role]);
    },
  );

  it.each(Object.keys(EXPECTED))('%s is a member of no role and inherits nothing', async (role) => {
    const [row] = await ownerDb.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM pg_auth_members WHERE member = ${role}::regrole`);
    expect(row?.n).toBe(0);
    const [shape] = await ownerDb.execute<{ ok: boolean }>(sql`
      SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AS ok
      FROM pg_roles WHERE rolname = ${role}`);
    expect(shape?.ok).toBe(true);
  });

  it.each([
    ['settlement', () => settlementDb],
    ['operator', () => operatorDb],
  ] as const)(
    "a stolen %s credential cannot reach the tenant's ordinary records",
    async (_who, db) => {
      const businessId = await seedBusiness();
      for (const table of [
        'invoices',
        'customers',
        'expenses',
        'payments',
        'documents',
        'conversation_messages',
        'sessions',
        'users',
        'memberships',
      ]) {
        expect(
          await outcome(
            withBusiness(db(), businessId, (tx) =>
              tx.execute(sql.raw(`SELECT 1 FROM ${table} LIMIT 1`)),
            ),
          ),
          table,
        ).toMatch(/42501 permission denied for table/);
      }
      expect(
        await outcome(
          withBusiness(db(), businessId, (tx) =>
            tx.execute(sql`UPDATE businesses SET name = 'Forged' WHERE id = ${businessId}::uuid`),
          ),
        ),
      ).toMatch(/42501 permission denied/);
    },
  );
});
