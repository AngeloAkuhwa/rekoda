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
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
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

    // A's action id through B's route reverts nothing and shows nothing.
    const revert = await call(
      'POST',
      `/v1/ops/staging/businesses/${b.id}/actions/${actionId}/revert`,
      staging,
      { reason: REASON },
    );
    expect(revert.statusCode).toBeGreaterThanOrEqual(400);
    const listed = await call('GET', `/v1/ops/staging/businesses/${b.id}/actions`, staging);
    // Refused outright, or an empty list: never A's action.
    expect(listed.body).not.toContain(actionId);
    expect(listed.body).not.toContain(a.id);

    const after = await snapshot();
    expect(after.stagingActions).toEqual(before.stagingActions);
    expect(await trialEnd(b.id)).toEqual(bEnd);
    expect(await trialEnd(a.id), "A's move still stands").not.toEqual(aEnd);
  });
});
