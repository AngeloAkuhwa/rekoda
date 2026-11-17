/**
 * The cutover enrolment of unrecorded dead jobs (OWN-73, OWN-76) reads a job's payload only under
 * that job's own tenant pin (final review of PR #432, 14 Nov 2026).
 *
 * The worker's queue policy (`worker_claim`, 0004) lets its credential read every tenant's job row,
 * because it claims work across tenants; the database therefore cannot refuse an unpinned payload
 * read, and this is an APPLICATION-LEVEL guarantee, proved here statement by statement: the only
 * cross-tenant step is the discovery function (0225), which returns job and business ids, and every
 * statement that reads a payload runs in a transaction pinned to the business that owns the job.
 * The database-level half (the discovery function's grants, column set and bound) is proved in
 * `dead-job-enrolment-scope.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { Db } from '../client.js';
import { jobsRepo } from '../index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const JOB_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Seen {
  text: string;
  pin: string | null;
}

/** A Db double that records every statement with the tenant pin in force when it ran. */
function recordingDb(answer: (text: string, params: unknown[]) => unknown[]): {
  db: Db;
  seen: Seen[];
} {
  const dialect = new PgDialect();
  const seen: Seen[] = [];
  const frame = (pin: string | null) => {
    const self = {
      pin,
      async execute(query: SQL) {
        const { sql: text, params } = dialect.sqlToQuery(query);
        if (/set_config\('app\.business_id'/.test(text)) self.pin = String(params[0]);
        seen.push({ text, pin: self.pin });
        return answer(text, params);
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(frame(self.pin));
      },
    };
    return self;
  };
  return { db: frame(null) as unknown as Db, seen };
}

const jobRow = (id: string, businessId: string) => ({
  id,
  business_id: businessId,
  kind: 'payment.process',
  payload: { eventId: null },
  attempts: 3,
  state: 'dead',
  failure_category: 'handler_error',
});

describe('enrolment reads a payload only under the job’s own tenant pin', () => {
  it('discovers ids only, then reads each job pinned to its own business', async () => {
    const { db, seen } = recordingDb((text, params) => {
      if (/dead_job_unrecorded_candidates/.test(text)) {
        return [
          { job_id: JOB_A, business_id: A },
          { job_id: JOB_B, business_id: B },
        ];
      }
      if (/\bpayload\b/.test(text) && /FROM jobs/i.test(text)) {
        const id = params.find((p) => p === JOB_A || p === JOB_B);
        return id === JOB_A ? [jobRow(JOB_A, A)] : id === JOB_B ? [jobRow(JOB_B, B)] : [];
      }
      return [];
    });
    await jobsRepo.enrolUnrecordedDeaths(db);

    const discovery = seen.filter((s) => /dead_job_unrecorded_candidates/.test(s.text));
    expect(discovery).toHaveLength(1);
    expect(discovery[0]!.text).not.toMatch(/\bpayload\b/);

    const payloadReads = seen.filter((s) => /\bpayload\b/.test(s.text));
    expect(payloadReads.length).toBe(2);
    for (const read of payloadReads) {
      expect([A, B]).toContain(read.pin);
      /* The read itself is bounded to the pinned tenant, not only run under it. */
      expect(read.text).toMatch(/current_setting\('app\.business_id', true\)/);
    }
    expect(payloadReads.map((r) => r.pin).sort()).toEqual([A, B]);
  });

  it('never queries a candidate whose ids are not UUIDs', async () => {
    const { db, seen } = recordingDb((text) =>
      /dead_job_unrecorded_candidates/.test(text)
        ? [
            { job_id: 'not-a-uuid', business_id: A },
            { job_id: JOB_B, business_id: "B'; --" },
          ]
        : [],
    );
    expect(await jobsRepo.enrolUnrecordedDeaths(db)).toBe(0);
    expect(seen.filter((s) => !/dead_job_unrecorded_candidates/.test(s.text))).toEqual([]);
  });
});

describe('the reclaim pass reads a dying job’s payload only under its own tenant pin', () => {
  it('returns no payload from the cross-tenant update, then reads each dead one pinned', async () => {
    const { db, seen } = recordingDb((text, params) => {
      if (/^\s*UPDATE jobs SET/i.test(text)) {
        const row = (id: string, businessId: string) => {
          const { payload: _payload, ...rest } = jobRow(id, businessId);
          return rest;
        };
        return [row(JOB_A, A), row(JOB_B, B)];
      }
      if (/\bjob_payload\(/.test(text)) {
        const id = params.find((p) => p === JOB_A || p === JOB_B);
        return id === JOB_A ? [{ payload: {} }] : id === JOB_B ? [{ payload: {} }] : [];
      }
      return [];
    });
    await jobsRepo.reclaimStalled(db);

    const update = seen.filter((s) => /^\s*UPDATE jobs SET/i.test(s.text));
    expect(update).toHaveLength(1);
    expect(update[0]!.text).not.toMatch(/\bpayload\b/);
    const payloadReads = seen.filter((s) => /\bpayload\b/.test(s.text));
    expect(payloadReads.map((r) => r.pin).sort()).toEqual([A, B]);
    for (const read of payloadReads) {
      /* Since 0228 the worker holds no SELECT on `jobs.payload`; the read goes through
       * `job_payload()`, which returns it only where the job's business is the pinned one
       * (database-level bound proved in `job-payload-isolation.integration.test.ts`). */
      expect(read.text).toMatch(/\bjob_payload\(\$\d+::uuid\)/);
      expect(read.text).not.toMatch(/FROM jobs/i);
    }
  });
});
