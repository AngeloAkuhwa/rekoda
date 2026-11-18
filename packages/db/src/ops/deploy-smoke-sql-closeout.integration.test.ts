/**
 * The staging pre-start smoke for the closeout round of PR #432 (owner instruction, 18 Nov 2026): the
 * operator-actor constraints are checked one by one (schema, owning table, name, constrained column,
 * validation and exact definition), and 0242's settlement transition guard is pinned. The harness is
 * shared with `deploy-smoke-sql.integration.test.ts`.
 *
 * Review D (D-5) found the actor check counting seven names with a tautological validation test; the
 * final review left a decoy of the same name on another table, or a `CHECK (true OR ...)`, able to
 * pass. Each tamper below must print `f`.
 */
import { describe, expect, it } from 'vitest';
import { smokeAfter, useSmokeHarness } from './deploy-smoke-sql.fixtures.js';

useSmokeHarness();

const CLOSED_BY = `closed_by IS NULL OR closed_by ~ '^(operator:[!-~]{1,255}|system:[a-z][a-z_-]{0,63})$'`;

describe('the pre-start database smoke, closeout round (actor constraints, 0242)', () => {
  it('prints t for the migrated boundary', async () => {
    expect(await smokeAfter('')).toBe('t');
  });

  it('still prints t once the intentionally NOT VALID constraint on main’s rows is validated', async () => {
    expect(
      await smokeAfter(
        'ALTER TABLE subscription_charges VALIDATE CONSTRAINT subscription_charges_unapplied_resolved_by_actor',
      ),
    ).toBe('t');
  });

  it.each([
    [
      'an actor check moved to a decoy table under the same name',
      `ALTER TABLE dead_job_exceptions DROP CONSTRAINT dead_job_exceptions_closed_by_actor;
       CREATE TABLE public.smoke_decoy (closed_by text,
         CONSTRAINT dead_job_exceptions_closed_by_actor CHECK (${CLOSED_BY}))`,
    ],
    [
      'an actor check moved to a table of the same name in another schema',
      `ALTER TABLE dead_job_exceptions DROP CONSTRAINT dead_job_exceptions_closed_by_actor;
       CREATE SCHEMA smoke_shadow;
       CREATE TABLE smoke_shadow.dead_job_exceptions (closed_by text,
         CONSTRAINT dead_job_exceptions_closed_by_actor CHECK (${CLOSED_BY}))`,
    ],
    [
      'an actor check loosened with CHECK (true OR ...) under its own name',
      `ALTER TABLE dead_job_exceptions DROP CONSTRAINT dead_job_exceptions_closed_by_actor,
         ADD CONSTRAINT dead_job_exceptions_closed_by_actor CHECK (true OR (${CLOSED_BY}))`,
    ],
    [
      'an actor check renamed onto another column of its table',
      `ALTER TABLE dead_job_exceptions DROP CONSTRAINT dead_job_exceptions_recovery_requested_by_actor,
         ADD CONSTRAINT dead_job_exceptions_recovery_requested_by_actor
           CHECK (recovery_reason IS NULL OR recovery_reason ~ '^operator:[!-~]{1,255}$')`,
    ],
    [
      'an actor check re-added NOT VALID, so existing rows are never checked',
      `ALTER TABLE staging_send_faults DROP CONSTRAINT staging_send_faults_armed_by_actor,
         ADD CONSTRAINT staging_send_faults_armed_by_actor
           CHECK (armed_by IS NULL OR armed_by ~ '^operator:[!-~]{1,255}$') NOT VALID`,
    ],
    [
      'the refund actor check dropped',
      'ALTER TABLE subscription_refunds DROP CONSTRAINT subscription_refunds_actor_check',
    ],
    [
      'the enrolment requeue actor check widened to any operator: prefix',
      `ALTER TABLE dead_job_enrolment_failures DROP CONSTRAINT dead_job_enrolment_failures_requeued_by_operator,
         ADD CONSTRAINT dead_job_enrolment_failures_requeued_by_operator
           CHECK (requeued_by IS NULL OR requeued_by ~ '^operator:')`,
    ],
    [
      'the settlement transition guard dropped (S-1)',
      'DROP TRIGGER jobs_settlement_transition_guard ON jobs',
    ],
    [
      'the settlement transition guard disabled (S-1)',
      'ALTER TABLE jobs DISABLE TRIGGER jobs_settlement_transition_guard',
    ],
    [
      'the settlement transition guard firing after the update, when it can no longer refuse (S-1)',
      `DROP TRIGGER jobs_settlement_transition_guard ON jobs;
       CREATE TRIGGER jobs_settlement_transition_guard AFTER UPDATE ON jobs
         FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_settlement_transition_guard()`,
    ],
    [
      'the settlement transition guard recognising settlement by name again (S-1)',
      `CREATE OR REPLACE FUNCTION rekoda_private.jobs_settlement_transition_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
       BEGIN
         IF current_user <> 'rekoda_settlement' THEN RETURN NEW; END IF;
         IF (OLD.state = 'pending' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts + 1)
            OR (OLD.state = 'running' AND NEW.state IN ('done', 'dead') AND NEW.attempts = OLD.attempts) THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'refused' USING ERRCODE = '42501';
       END $$`,
    ],
    [
      'the settlement transition guard letting a dead job back to the queue (S-1)',
      `CREATE OR REPLACE FUNCTION rekoda_private.jobs_settlement_transition_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
       BEGIN
         IF NOT pg_has_role(current_user, 'rekoda_settlement', 'USAGE')
            OR pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE') THEN
           RETURN NEW;
         END IF;
         IF NEW.run_at > now() + interval '10 minutes' THEN RAISE EXCEPTION 'x'; END IF;
         IF (OLD.state = 'pending' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts + 1)
            OR (OLD.state = 'running' AND NEW.state IN ('done', 'dead') AND NEW.attempts = OLD.attempts)
            OR (OLD.state = 'dead' AND NEW.state = 'pending') THEN
           RETURN NEW;
         END IF;
         RAISE EXCEPTION 'refused' USING ERRCODE = '42501';
       END $$`,
    ],
    [
      '0242 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0242_settlement_job_transitions'",
    ],
  ])('prints f for %s', async (_label, tamper) => {
    expect(await smokeAfter(tamper)).toBe('f');
  });
});
