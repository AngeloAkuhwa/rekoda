/**
 * Object-level authorisation (IDOR) over the PR B surface, through real HTTP, scoped operator
 * tokens and business sessions (harness: `ops-idor-harness.ts`). A rejected request must change
 * nothing: each refusal is checked by comparing a snapshot of the records it could have touched.
 *
 * Vertical: a caller without the scope. Horizontal: business A reaching business B's records.
 * Operational: an operator pointing a recovery or resolution at a record it does not match.
 */
import { describe, expect, it } from 'vitest';
import { settleRepo, sql, withBusiness } from '@rekoda/db';
import {
  REASON,
  appDb,
  attributedEvent,
  blockedRenewal,
  business,
  call,
  deadJob,
  operator,
  ownerDb,
  snapshot,
  useHarness,
} from './ops-idor-harness.js';

useHarness();

/* ── vertical: who may call the operator plane at all ───────────────────── */

describe('vertical: the operator plane is closed to everyone without the right scope', () => {
  it('refuses no credential, a business session and a forged token, and changes nothing', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    const before = await snapshot();
    const forged = { authorization: 'Bearer not.a.token' };

    const routes: Array<['GET' | 'POST', string, object?]> = [
      ['GET', '/v1/ops/exceptions'],
      ['POST', `/v1/ops/dead-jobs/${job}/recover`, { reason: REASON }],
      ['POST', `/v1/ops/dead-jobs/${job}/resolve`, { resolution: REASON }],
      [
        'POST',
        '/v1/ops/exceptions/renewals/RKD-SUB-20261108-AAAAAA/resolve',
        { resolution: REASON },
      ],
      ['POST', `/v1/ops/staging/businesses/${a.id}/designate`, { reason: REASON }],
      ['GET', `/v1/ops/staging/businesses/${a.id}/actions`],
    ];
    for (const [method, url, body] of routes) {
      for (const headers of [{}, a.session, forged]) {
        const r = await call(method, url, headers, body);
        expect(r.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it('ops:read lists but cannot recover, resolve or touch staging', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    const read = await operator('ops:read');
    const before = await snapshot();

    expect((await call('GET', '/v1/ops/exceptions', read)).statusCode).toBe(200);
    const denied: Array<[string, object]> = [
      [`/v1/ops/dead-jobs/${job}/recover`, { reason: REASON }],
      [`/v1/ops/dead-jobs/${job}/resolve`, { resolution: REASON }],
      ['/v1/ops/exceptions/renewals/RKD-SUB-20261108-AAAAAA/resolve', { resolution: REASON }],
      [`/v1/ops/staging/businesses/${a.id}/designate`, { reason: REASON }],
      [`/v1/ops/staging/businesses/${a.id}/faults`, { kind: 'send_timeout', reason: REASON }],
    ];
    for (const [url, body] of denied) {
      expect((await call('POST', url, read, body)).statusCode, url).toBe(403);
    }
    expect((await call('GET', `/v1/ops/staging/businesses/${a.id}/actions`, read)).statusCode).toBe(
      403,
    );
    expect(await snapshot()).toEqual(before);
  });

  it('ops:payment cannot use staging, and ops:staging cannot recover or resolve', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    const before = await snapshot();
    const payment = await operator('ops:payment');
    const staging = await operator('ops:staging');

    expect(
      (
        await call('POST', `/v1/ops/staging/businesses/${a.id}/designate`, payment, {
          reason: REASON,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/recover`, staging, { reason: REASON }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, staging, { resolution: REASON }))
        .statusCode,
    ).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it('a business id, role or scope smuggled into a body grants nothing and is never trusted', async () => {
    const a = await business();
    const b = await business();
    const jobA = await deadJob(a.id, await attributedEvent(a.id));
    const jobB = await deadJob(b.id, await attributedEvent(b.id));
    const payment = await operator('ops:payment');

    // The route names the job; a body naming business B cannot move the action to B.
    const r = await call('POST', `/v1/ops/dead-jobs/${jobA}/resolve`, payment, {
      resolution: REASON,
      businessId: b.id,
      scopes: ['ops:staging'],
    });
    expect(r.statusCode).toBe(200);
    const rows = await ownerDb.execute<{ job_id: string; status: string }>(
      sql`SELECT job_id, status FROM dead_job_exceptions`,
    );
    const byJob = Object.fromEntries([...rows].map((x) => [x.job_id, x.status]));
    expect(byJob[jobA]).toBe('resolved');
    expect(byJob[jobB]).toBe('open');
    const audit = await ownerDb.execute<{ business_id: string }>(
      sql`SELECT business_id FROM audit_events WHERE action = 'dead_job_resolved'`,
    );
    expect([...audit].map((x) => x.business_id)).toEqual([a.id]);
  });
});

/* ── horizontal: a business reaching another business's records ─────────── */

describe('horizontal: business A cannot reach business B through an id or reference', () => {
  it("B's payment record reads as nothing to A, exactly like a reference that never existed", async () => {
    const a = await business();
    const b = await business();
    await blockedRenewal(b.id, 'RKD-SUB-20261108-BBBBBB', false);

    const theirs = await call('GET', '/v1/billing/payments/RKD-SUB-20261108-BBBBBB', a.session);
    const never = await call('GET', '/v1/billing/payments/RKD-SUB-20261108-ZZZZZZ', a.session);
    expect(theirs.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    expect(theirs.body).toBe(never.body);
    expect(
      (await call('GET', '/v1/billing/payments/RKD-SUB-20261108-BBBBBB', b.session)).statusCode,
    ).toBe(200);
  });

  it("B's dead job never shows on A's billing page, and A cannot resolve B's payment exception", async () => {
    const a = await business();
    const b = await business();
    await deadJob(b.id, await attributedEvent(b.id));
    const bException = (
      await withBusiness(appDb, b.id, (tx) =>
        settleRepo.reconciliationsFor(tx, { status: 'EXCEPTION', limit: 10 }),
      )
    ).find((r) => r.reason === 'payment_processing_stopped')!;
    const before = await snapshot();

    const overview = (await call('GET', '/v1/billing', a.session)).json() as {
      processingIssue: unknown;
    };
    expect(overview.processingIssue).toBeNull();
    const listed = (await call('GET', '/v1/payments/exceptions', a.session)).json() as {
      exceptions: Array<{ id: string }>;
    };
    expect(listed.exceptions.map((e) => e.id)).not.toContain(bException.id);

    const stolen = await call(
      'POST',
      `/v1/payments/exceptions/${bException.id}/resolve`,
      a.session,
    );
    expect(stolen.statusCode).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it('a business session cannot call the operator routes for its own or another business', async () => {
    const a = await business();
    const b = await business();
    const jobB = await deadJob(b.id, await attributedEvent(b.id));
    const before = await snapshot();
    for (const url of [
      `/v1/ops/dead-jobs/${jobB}/resolve`,
      `/v1/ops/dead-jobs/${jobB}/recover`,
      `/v1/ops/staging/businesses/${a.id}/designate`,
    ]) {
      const r = await call('POST', url, a.session, { reason: REASON, resolution: REASON });
      expect(r.statusCode, url).toBe(401);
    }
    expect(await snapshot()).toEqual(before);
  });
});

/* ── operational: an operator pointing at the wrong record ──────────────── */

describe('operational: a recovery or resolution acts only on the record it names', () => {
  const payment = () => operator('ops:payment');

  it('an unknown job id is a 404 and changes nothing', async () => {
    const a = await business();
    await deadJob(a.id, await attributedEvent(a.id));
    const before = await snapshot();
    const unknown = '00000000-0000-4000-8000-00000000dead';
    for (const action of ['recover', 'resolve']) {
      const r = await call('POST', `/v1/ops/dead-jobs/${unknown}/${action}`, await payment(), {
        reason: REASON,
        resolution: REASON,
      });
      expect(r.statusCode, action).toBe(404);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("a job of A that names B's event never binds, recovers, or resolves B's event", async () => {
    const a = await business();
    const b = await business();
    const eventB = await attributedEvent(b.id);
    const jobA = await deadJob(a.id, eventB); // A's payload points at B's event
    const jobB = await deadJob(b.id, eventB);

    const record = (
      await ownerDb.execute<{ event_id: string | null }>(
        sql`SELECT event_id FROM dead_job_exceptions WHERE job_id = ${jobA}::uuid`,
      )
    )[0];
    expect(record?.event_id, "a foreign event is never bound to A's record").toBeNull();

    const before = await snapshot();
    const recover = await call('POST', `/v1/ops/dead-jobs/${jobA}/recover`, await payment(), {
      reason: REASON,
    });
    expect(recover.statusCode).toBe(422); // nothing to verify: no event of A's own
    const afterRecover = await snapshot();
    // The refusal is audited against A's own job; nothing else moved, and nothing was requeued.
    expect(afterRecover.jobs).toEqual(before.jobs);
    expect(afterRecover.events).toEqual(before.events);
    expect(afterRecover.deadJobs).toEqual(before.deadJobs);

    const resolve = await call('POST', `/v1/ops/dead-jobs/${jobA}/resolve`, await payment(), {
      resolution: REASON,
    });
    expect(resolve.statusCode).toBe(200);
    const after = await snapshot();
    expect(after.events, "B's event is untouched by A's resolution").toEqual(before.events);
    const status = Object.fromEntries(
      (after.deadJobs as Array<{ job_id: string; status: string }>).map((r) => [
        r.job_id,
        r.status,
      ]),
    );
    expect(status[jobA]).toBe('resolved');
    expect(status[jobB]).toBe('open');
  });

  it('a job that is already closed cannot be recovered or resolved again', async () => {
    const a = await business();
    const job = await deadJob(a.id, await attributedEvent(a.id));
    expect(
      (
        await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, await payment(), {
          resolution: REASON,
        })
      ).statusCode,
    ).toBe(200);
    const before = await snapshot();
    expect(
      (await call('POST', `/v1/ops/dead-jobs/${job}/recover`, await payment(), { reason: REASON }))
        .statusCode,
    ).toBe(409);
    expect(
      (
        await call('POST', `/v1/ops/dead-jobs/${job}/resolve`, await payment(), {
          resolution: REASON,
        })
      ).statusCode,
    ).toBe(409);
    const after = await snapshot();
    // Nothing was requeued, reopened or re-resolved. A refused recovery may be audited as refused.
    expect({ ...after, audit: null }).toEqual({ ...before, audit: null });
    const added = (after.audit as Array<{ action: string }>).slice(
      (before.audit as unknown[]).length,
    );
    expect(added.every((a) => a.action === 'dead_job_recovery_refused')).toBe(true);
  });

  it('the generic event resolve cannot close an event that belongs to an open dead job', async () => {
    const a = await business();
    const event = await attributedEvent(a.id);
    await deadJob(a.id, event);
    const before = await snapshot();
    const r = await call('POST', `/v1/ops/exceptions/${event}/resolve`, await payment(), {
      resolution: REASON,
    });
    expect(r.statusCode).toBe(409);
    expect(await snapshot()).toEqual(before);
  });

  it('a blocked-renewal reference resolves only that renewal, once, and nothing else', async () => {
    const a = await business();
    const b = await business();
    await blockedRenewal(a.id, 'RKD-SUB-20261108-AAAAAA', true);
    await blockedRenewal(b.id, 'RKD-SUB-20261108-BBBBBB', true); // another open block
    await blockedRenewal(b.id, 'RKD-SUB-20261108-CCCCCC', false); // a plain renewal, never blocked
    const op = await payment();
    const route = (ref: string) => `/v1/ops/exceptions/renewals/${ref}/resolve`;

    const before = await snapshot();
    // A renewal that was never blocked, a reference that does not exist, and a malformed one.
    expect(
      (await call('POST', route('RKD-SUB-20261108-CCCCCC'), op, { resolution: REASON })).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', route('RKD-SUB-20261108-ZZZZZZ'), op, { resolution: REASON })).statusCode,
    ).toBe(404);
    expect(
      (await call('POST', route('not-a-reference'), op, { resolution: REASON })).statusCode,
    ).toBe(404);
    expect(await snapshot()).toEqual(before);

    expect(
      (await call('POST', route('RKD-SUB-20261108-AAAAAA'), op, { resolution: REASON })).statusCode,
    ).toBe(200);
    const after = Object.fromEntries(
      (await snapshot()).charges.map((c) => [
        (c as { reference: string }).reference,
        (c as { blocked_resolved_at: unknown }).blocked_resolved_at !== null,
      ]),
    );
    expect(after).toEqual({
      'RKD-SUB-20261108-AAAAAA': true,
      'RKD-SUB-20261108-BBBBBB': false,
      'RKD-SUB-20261108-CCCCCC': false,
    });
    const audit = await ownerDb.execute<{ business_id: string; entity_id: string }>(
      sql`SELECT business_id, entity_id FROM audit_events WHERE action = 'renewal_block_resolved'`,
    );
    expect([...audit]).toEqual([{ business_id: a.id, entity_id: 'RKD-SUB-20261108-AAAAAA' }]);
    expect(
      (await call('POST', route('RKD-SUB-20261108-AAAAAA'), op, { resolution: REASON })).statusCode,
    ).toBe(409);
  });
});
