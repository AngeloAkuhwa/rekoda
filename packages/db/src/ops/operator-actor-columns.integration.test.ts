/**
 * B-2 (independent review of the PR #432 remediation; migration 0239): every column that records
 * who acted on an operator item follows the operator-actor contract, `operator:<subject>` with a
 * subject of 1 to 255 printable characters (as `auditActorOf` produces it), or `system:<name>`
 * where a system writer may act. Checked at the column, whoever writes it.
 *
 * What it does not prove, and is not claimed (OD-54): that the actor is the operator who acted. On
 * app-plane routes the API verifies the identity; the database only refuses malformed actors.
 */
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withBusiness } from '../client.js';
import {
  outcome,
  ownerDb,
  seedBusiness,
  usePlanWriterHarness,
} from '../billing/plan-writer.fixtures.js';

usePlanWriterHarness();

const LONGEST = `operator:${'s'.repeat(255)}`;
const MALFORMED = [
  `operator:${'s'.repeat(256)}`,
  'alice',
  'operator:',
  'operator:has space',
  'operator:new\nline',
  'OPERATOR:ada',
  ' operator:ada',
];

/** One row per table, staged as the owner, so each column can be written on its own. */
async function rows(businessId: string) {
  return withBusiness(ownerDb, businessId, async (tx) => {
    const [job] = await tx.execute<{ id: string }>(sql`
      INSERT INTO jobs (business_id, kind, payload, state, attempts, max_attempts)
      VALUES (${businessId}::uuid, 'payment.process', '{"eventId": null}'::jsonb, 'dead', 2, 2)
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO dead_job_exceptions (job_id, business_id, kind, summary, attempts)
      VALUES (${job!.id}::uuid, ${businessId}::uuid, 'payment.process', 'stopped', 2)`);
    const [charge] = await tx.execute<{ id: string }>(sql`
      INSERT INTO subscription_charges
        (business_id, kind, plan, amount_k, status, reference, period_start, period_end,
         pricing_source, billing_interval)
      VALUES (${businessId}::uuid, 'renewal', 'chat', 990000, 'pending',
              ${`RKD-SUB-20261118-${String(Date.now()).slice(-6)}`}, now(), now() + interval '30 days',
              'catalogue', 'monthly')
      RETURNING id`);
    await tx.execute(sql`
      INSERT INTO staging_test_businesses (business_id, designated_by, reason)
      VALUES (${businessId}::uuid, 'operator:ada', 'acceptance')`);
    const [action] = await tx.execute<{ id: string }>(sql`
      INSERT INTO staging_tool_actions (business_id, operator, action, reason, outcome)
      VALUES (${businessId}::uuid, 'operator:ada', 'designate', 'acceptance', 'done') RETURNING id`);
    const [fault] = await tx.execute<{ id: string }>(sql`
      INSERT INTO staging_send_faults (business_id, kind, armed_by)
      VALUES (${businessId}::uuid, 'send_timeout', 'operator:ada') RETURNING id`);
    return { job: job!.id, charge: charge!.id, action: action!.id, fault: fault!.id };
  });
}

const COLUMNS = [
  {
    table: 'dead_job_exceptions',
    column: 'recovery_requested_by',
    key: 'job_id',
    of: 'job',
    system: false,
  },
  { table: 'dead_job_exceptions', column: 'closed_by', key: 'job_id', of: 'job', system: true },
  {
    table: 'subscription_charges',
    column: 'blocked_resolved_by',
    key: 'id',
    of: 'charge',
    system: true,
  },
  {
    table: 'subscription_charges',
    column: 'unapplied_resolved_by',
    key: 'id',
    of: 'charge',
    system: true,
  },
  {
    table: 'staging_test_businesses',
    column: 'designated_by',
    key: 'business_id',
    of: 'business',
    system: false,
  },
  { table: 'staging_tool_actions', column: 'operator', key: 'id', of: 'action', system: false },
  { table: 'staging_send_faults', column: 'armed_by', key: 'id', of: 'fault', system: false },
] as const;

describe('B-2 (0239): operator-actor columns follow the contract', () => {
  for (const c of COLUMNS) {
    it(`${c.table}.${c.column} accepts the longest valid actor and refuses malformed ones`, async () => {
      const businessId = await seedBusiness();
      const ids = { ...(await rows(businessId)), business: businessId };
      const write = (actor: string) =>
        outcome(
          ownerDb.execute(
            sql`UPDATE ${sql.identifier(c.table)} SET ${sql.identifier(c.column)} = ${actor}
              WHERE ${sql.identifier(c.key)} = ${ids[c.of]}::uuid`,
          ),
        );
      expect(await write(LONGEST)).toBe('allowed');
      for (const bad of MALFORMED) {
        expect(await write(bad), bad).toMatch(/^23514 /);
      }
      if (c.system) expect(await write('system:recovery')).toBe('allowed');
      else expect(await write('system:recovery')).toMatch(/^23514 /);
      expect(await write('system:Bad Name')).toMatch(/^23514 /);
    });
  }
});
