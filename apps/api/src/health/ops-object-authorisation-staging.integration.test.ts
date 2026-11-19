/**
 * Object-level authorisation (IDOR) for the staging tools (OWN-77): the environment marker and the
 * designated-business scope, through real HTTP and scoped operator tokens (harness:
 * `ops-idor-harness.ts`).
 */
import { describe, expect, it } from 'vitest';
import { sql } from '@rekoda/db';
import {
  DAY,
  REASON,
  business,
  call,
  operator,
  ownerDb,
  snapshot,
  useHarness,
} from './ops-idor-harness.js';

useHarness();

/* ── staging tools: environment safeguards and per-business scope ───────── */

describe('staging tools act only on the designated business named in the route', () => {
  const mark = () =>
    ownerDb.execute(sql`INSERT INTO staging_environment (marked_by) VALUES ('owner:test')`);
  const trialEnd = async (id: string) =>
    new Date(
      (
        await ownerDb.execute<{ plan_expires_at: string | Date }>(
          sql`SELECT plan_expires_at FROM businesses WHERE id = ${id}::uuid`,
        )
      )[0]!.plan_expires_at,
    );

  it('without the database marker every staging route refuses and writes nothing', async () => {
    const a = await business();
    const staging = await operator('ops:staging');
    const before = await snapshot();
    const r = await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, staging, {
      reason: REASON,
    });
    // Exactly the staging-marker refusal, not any 4xx (a bad token or body would also be one).
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('this database is not marked as staging');
    expect(await snapshot()).toEqual(before);
  });

  it('designating A gives no power over B: dates, faults and reverts refuse for B', async () => {
    await mark();
    const a = await business();
    const b = await business();
    const staging = await operator('ops:staging');
    const designate = await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, staging, {
      reason: REASON,
    });
    expect(designate.statusCode).toBe(200);

    const aEnd = await trialEnd(a.id);
    const moved = await call('POST', `/v1/ops/staging/businesses/${a.id}/dates`, staging, {
      field: 'trial_end',
      expected: aEnd.toISOString(),
      to: new Date(Date.now() - DAY).toISOString(),
      reason: REASON,
    });
    expect(moved.statusCode).toBe(200);
    const actionId = (moved.json() as { actionId: string }).actionId;
    const before = await snapshot();
    const bEnd = await trialEnd(b.id);

    // B is not a designated test business.
    const moveB = await call('POST', `/v1/ops/staging/businesses/${b.id}/dates`, staging, {
      field: 'trial_end',
      expected: bEnd.toISOString(),
      to: new Date(Date.now() - DAY).toISOString(),
      reason: REASON,
    });
    expect(moveB.statusCode).toBeGreaterThanOrEqual(400);
    const faultB = await call('POST', `/v1/ops/staging/businesses/${b.id}/faults`, staging, {
      kind: 'send_timeout',
      reason: REASON,
    });
    expect(faultB.statusCode).toBeGreaterThanOrEqual(400);

    // B is also designated, so the next requests get past the designation check and reach the
    // action lookup itself: A's action id through B's route must still find nothing.
    expect(
      (
        await call('POST', `/v1/ops/staging/businesses/${b.id}/designate`, staging, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(200);
    const revert = await call(
      'POST',
      `/v1/ops/staging/businesses/${b.id}/actions/${actionId}/revert`,
      staging,
      { reason: REASON },
    );
    expect(revert.statusCode).toBeGreaterThanOrEqual(400);
    expect(revert.statusCode).toBeLessThan(500);
    const listed = await call('GET', `/v1/ops/staging/businesses/${b.id}/actions`, staging);
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(actionId);
    expect(listed.body).not.toContain(a.id);

    // Refused as a client error (never a server fault), and no fault was armed for anyone.
    expect(moveB.statusCode).toBeLessThan(500);
    expect(faultB.statusCode).toBeLessThan(500);
    expect(revert.statusCode).toBeLessThan(500);
    expect(await ownerDb.execute(sql`SELECT 1 FROM staging_send_faults`)).toHaveLength(0);

    const after = await snapshot();
    const rowsOf = (all: unknown[], id: string) =>
      (all as Array<{ business_id: string }>).filter((r) => r.business_id === id);
    // A's log is exactly as it was (the revert reverted nothing); B's holds only its own designation.
    expect(rowsOf(after.stagingActions, a.id)).toEqual(rowsOf(before.stagingActions, a.id));
    expect(rowsOf(after.stagingActions, b.id)).toHaveLength(1);
    expect(await trialEnd(b.id)).toEqual(bEnd);
    expect(await trialEnd(a.id), "A's move still stands").not.toEqual(aEnd);
  });
});
