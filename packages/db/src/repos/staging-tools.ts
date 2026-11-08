/**
 * Staging test-business tools (G-119 / OWN-77; migration 0197).
 *
 * The database half of a two-layer fence: every function here acts only on a database that
 * carries the staging marker (written by the owner on the staging host, never by an application
 * role) and only for a designated test business. The API half (REKODA_STAGING_TOOLS, a test
 * Paystack key, `ops:staging`) refuses before any of this is called. Everything that acts is
 * audited in `staging_tool_actions`, which no application role can change or delete.
 */
import { sql } from 'drizzle-orm';
import type { Db, TenantDb } from '../client.js';

export type StagingDateField = 'trial_end' | 'paid_to' | 'grace_clock';
export type StagingFaultKind = 'send_timeout' | 'sender_refused';

/** Whether this database is marked as staging. Readable by the application and worker roles. */
export async function isStagingDatabase(db: Pick<Db, 'execute'>): Promise<boolean> {
  const rows = await db.execute<{ marked: boolean }>(
    sql`SELECT EXISTS (SELECT 1 FROM staging_environment) AS marked`,
  );
  return [...rows][0]?.marked === true;
}

export async function isTestBusiness(tx: TenantDb, businessId: string): Promise<boolean> {
  const rows = await tx.execute<{ yes: boolean }>(sql`
    SELECT EXISTS (SELECT 1 FROM staging_test_businesses WHERE business_id = ${businessId}::uuid)
      AS yes`);
  return [...rows][0]?.yes === true;
}

/**
 * Designate a business as a test business, once, audited. Only on a staging database: the marker
 * is checked in the same statement, so a production database inserts nothing.
 */
export async function designateTestBusiness(
  tx: TenantDb,
  input: { businessId: string; operator: string; reason: string },
): Promise<'designated' | 'already' | 'not_staging'> {
  if (!(await isStagingDatabase(tx))) return 'not_staging';
  const rows = await tx.execute<{ business_id: string }>(sql`
    INSERT INTO staging_test_businesses (business_id, designated_by, reason)
    SELECT ${input.businessId}::uuid, ${input.operator}, ${input.reason}
    WHERE EXISTS (SELECT 1 FROM staging_environment)
    ON CONFLICT (business_id) DO NOTHING
    RETURNING business_id`);
  if ([...rows].length === 0) return 'already';
  await tx.execute(sql`
    INSERT INTO staging_tool_actions (business_id, operator, action, reason, outcome)
    VALUES (${input.businessId}::uuid, ${input.operator}, 'designate', ${input.reason}, 'applied')`);
  return 'designated';
}

/** The current value of a movable date, for the compare-before. */
export async function currentDate(
  tx: TenantDb,
  businessId: string,
  field: StagingDateField,
): Promise<{ plan: string; value: Date | null } | null> {
  const rows = await tx.execute<{ plan: string; value: string | null }>(sql`
    SELECT plan,
           ${field === 'grace_clock' ? sql`payment_failed_at` : sql`plan_expires_at`} AS value
    FROM businesses WHERE id = ${businessId}::uuid`);
  const row = [...rows][0];
  return row ? { plan: row.plan, value: row.value ? new Date(row.value) : null } : null;
}

/**
 * Move one date through the database's sanctioned writer (`staging_move_date`, owned by
 * `rekoda_plan_writer`, OD-37). It refuses (throws, writing nothing) unless the database is
 * staging, the business is a designated test business, the field fits the plan, the value still
 * equals `expected`, and the new value is within 90 days of now. Returns the audit row's id.
 */
export async function moveDate(
  tx: TenantDb,
  input: {
    businessId: string;
    field: StagingDateField;
    expected: Date | null;
    to: Date;
    operator: string;
    reason: string;
    reverts?: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    SELECT staging_move_date(
      ${input.businessId}::uuid, ${input.field},
      ${input.expected ? input.expected.toISOString() : null}::timestamptz,
      ${input.to.toISOString()}::timestamptz,
      ${input.operator}, ${input.reason}, ${input.reverts ?? null}::uuid) AS id`);
  return [...rows][0]!.id;
}

export interface StagingAction {
  id: string;
  businessId: string;
  operator: string;
  action: string;
  field: string | null;
  before: Date | null;
  after: Date | null;
  reason: string;
  outcome: string;
  revertsActionId: string | null;
  createdAt: Date;
}

const shapeAction = (r: Record<string, unknown>): StagingAction => ({
  id: String(r['id']),
  businessId: String(r['business_id']),
  operator: String(r['operator']),
  action: String(r['action']),
  field: (r['field'] as string | null) ?? null,
  before: r['before_value'] ? new Date(String(r['before_value'])) : null,
  after: r['after_value'] ? new Date(String(r['after_value'])) : null,
  reason: String(r['reason']),
  outcome: String(r['outcome']),
  revertsActionId: (r['reverts_action_id'] as string | null) ?? null,
  createdAt: new Date(String(r['created_at'])),
});

export async function actionById(
  tx: TenantDb,
  businessId: string,
  id: string,
): Promise<StagingAction | null> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM staging_tool_actions
    WHERE business_id = ${businessId}::uuid AND id = ${id}::uuid`);
  const row = [...rows][0];
  return row ? shapeAction(row) : null;
}

/** A business's action log, newest first: the evidence an acceptance run records. */
export async function actionsFor(tx: TenantDb, businessId: string): Promise<StagingAction[]> {
  const rows = await tx.execute<Record<string, unknown>>(sql`
    SELECT * FROM staging_tool_actions WHERE business_id = ${businessId}::uuid
    ORDER BY created_at DESC, id`);
  return [...rows].map(shapeAction);
}

/**
 * Arm one send fault for a designated test business on a staging database. At most one may be
 * armed per business; a second answers 'already_armed' and writes nothing.
 */
export async function armFault(
  tx: TenantDb,
  input: { businessId: string; kind: StagingFaultKind; operator: string; reason: string },
): Promise<'armed' | 'already_armed' | 'not_staging' | 'not_test_business'> {
  if (!(await isStagingDatabase(tx))) return 'not_staging';
  if (!(await isTestBusiness(tx, input.businessId))) return 'not_test_business';
  const rows = await tx.execute<{ id: string }>(sql`
    INSERT INTO staging_send_faults (business_id, kind, armed_by)
    VALUES (${input.businessId}::uuid, ${input.kind}, ${input.operator})
    ON CONFLICT (business_id) WHERE consumed_at IS NULL DO NOTHING
    RETURNING id`);
  if ([...rows].length === 0) return 'already_armed';
  await tx.execute(sql`
    INSERT INTO staging_tool_actions (business_id, operator, action, field, reason, outcome)
    VALUES (${input.businessId}::uuid, ${input.operator}, 'arm_fault', ${input.kind},
            ${input.reason}, 'applied')`);
  return 'armed';
}

/**
 * Take the armed fault for this business, if any: exactly one caller gets it (the row is consumed
 * under SKIP LOCKED), and the consumption is audited in the same transaction. Only ever called
 * when the API's staging flag is on; on a database with no marker it finds nothing to consume.
 */
export async function consumeFault(
  tx: TenantDb,
  businessId: string,
): Promise<StagingFaultKind | null> {
  const rows = await tx.execute<{ kind: StagingFaultKind }>(sql`
    UPDATE staging_send_faults SET consumed_at = now()
    WHERE id = (
      SELECT f.id FROM staging_send_faults f
      WHERE f.business_id = ${businessId}::uuid AND f.consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM staging_environment)
      ORDER BY f.armed_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED)
    RETURNING kind`);
  const kind = [...rows][0]?.kind ?? null;
  if (kind) {
    await tx.execute(sql`
      INSERT INTO staging_tool_actions (business_id, operator, action, field, reason, outcome)
      VALUES (${businessId}::uuid, 'system:send', 'consume_fault', ${kind},
              'consumed by one send', 'consumed')`);
  }
  return kind;
}
