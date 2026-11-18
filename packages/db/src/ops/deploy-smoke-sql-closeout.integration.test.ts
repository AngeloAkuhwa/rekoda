/**
 * The staging pre-start smoke for the closeout round of PR #432 (owner instruction, 18 Nov 2026): the
 * operator-actor constraints are checked one by one (schema, owning table, name, constrained column,
 * validation and exact definition), 0242's settlement transition guard is pinned, and (round G) the
 * refund function of 0244 and its boundary function are pinned. The harness is
 * shared with `deploy-smoke-sql.integration.test.ts`.
 *
 * Review D (D-5) found the actor check counting seven names with a tautological validation test; the
 * final review left a decoy of the same name on another table, or a `CHECK (true OR ...)`, able to
 * pass. Each tamper below must print `f`.
 */
import { describe, expect, it } from 'vitest';
import { migrationText, smokeAfter, useSmokeHarness } from './deploy-smoke-sql.fixtures.js';

useSmokeHarness();

const CLOSED_BY = `closed_by IS NULL OR closed_by ~ '^(operator:[!-~]{1,255}|system:[a-z][a-z_-]{0,63})$'`;

describe('the pre-start database smoke, closeout round (actor constraints, 0242, 0244)', () => {
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
      /* Rows other suites left are cleared first (the transaction rolls back), so the tamper applies. */
      `DELETE FROM dead_job_exceptions;
       ALTER TABLE dead_job_exceptions DROP CONSTRAINT dead_job_exceptions_recovery_requested_by_actor,
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
      'the 0239 draft (ebb8d79): staging_tool_actions.operator refusing system: actors (E-F1)',
      `ALTER TABLE staging_tool_actions DROP CONSTRAINT staging_tool_actions_operator_actor,
         ADD CONSTRAINT staging_tool_actions_operator_actor
           CHECK (operator IS NULL OR operator ~ '^operator:[!-~]{1,255}$')`,
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
      'an actor check whose end anchor became a literal @ (review B)',
      `DELETE FROM subscription_refunds;
       ALTER TABLE subscription_refunds DROP CONSTRAINT subscription_refunds_actor_check,
         ADD CONSTRAINT subscription_refunds_actor_check CHECK (actor ~ '^operator:[!-~]{1,255}@')`,
    ],
    [
      'the settlement transition guard made SECURITY DEFINER, so its owner exemption covers everyone (review B)',
      'ALTER FUNCTION rekoda_private.jobs_settlement_transition_guard() SECURITY DEFINER',
    ],
    [
      'the settlement transition guard with another search_path (review B)',
      'ALTER FUNCTION rekoda_private.jobs_settlement_transition_guard() SET search_path = public, pg_catalog',
    ],
    [
      'the worker transition guard made SECURITY DEFINER (review B)',
      'ALTER FUNCTION rekoda_private.jobs_worker_transition_guard() SECURITY DEFINER',
    ],
    [
      'the settlement transition guard returning early, with the pinned text kept in a comment (review B)',
      `CREATE OR REPLACE FUNCTION rekoda_private.jobs_settlement_transition_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $f$
       BEGIN
         RETURN NEW;
         /* NOT pg_has_role(current_user, 'rekoda_settlement', 'USAGE')
            pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
            interval '10 minutes'
            OLD.state = 'pending' AND NEW.state = 'running' AND NEW.attempts = OLD.attempts + 1
            OLD.state = 'running' AND NEW.state IN ('done', 'dead') AND NEW.attempts = OLD.attempts */
       END $f$`,
    ],
    [
      'the worker transition guard returning early, with the pinned text kept in a comment (review B)',
      `CREATE OR REPLACE FUNCTION rekoda_private.jobs_worker_transition_guard() RETURNS trigger
       LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $f$
       BEGIN
         RETURN NEW;
         /* NOT pg_has_role(current_user, 'rekoda_worker', 'USAGE')
            pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'USAGE')
            OLD.state = 'pending' AND NEW.state = 'running'
            OLD.state = 'running' AND NEW.state IN ('done', 'pending', 'dead') */
       END $f$`,
    ],
    [
      'the refund function back at 0240, judging the allowance before the counter lock (review A)',
      migrationText('0240_pack_refund_allowance_history.sql').match(
        /CREATE OR REPLACE FUNCTION public\.subscription_record_refund\([\s\S]*?END \$function\$;/,
      )![0],
    ],
    [
      'the worker transition guard rebound as AFTER INSERT (delta review)',
      `DROP TRIGGER jobs_worker_transition_guard ON jobs;
       CREATE TRIGGER jobs_worker_transition_guard AFTER INSERT ON jobs
         FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_worker_transition_guard()`,
    ],
    [
      'the settlement transition guard firing only for an update of payload (delta review)',
      `DROP TRIGGER jobs_settlement_transition_guard ON jobs;
       CREATE TRIGGER jobs_settlement_transition_guard BEFORE UPDATE OF payload ON jobs
         FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_settlement_transition_guard()`,
    ],
    [
      'the settlement transition guard with WHEN (false) (delta review)',
      `DROP TRIGGER jobs_settlement_transition_guard ON jobs;
       CREATE TRIGGER jobs_settlement_transition_guard BEFORE UPDATE ON jobs
         FOR EACH ROW WHEN (false) EXECUTE FUNCTION rekoda_private.jobs_settlement_transition_guard()`,
    ],
    [
      'the worker transition guard bound to the settlement function (delta review)',
      `DROP TRIGGER jobs_worker_transition_guard ON jobs;
       CREATE TRIGGER jobs_worker_transition_guard BEFORE UPDATE ON jobs
         FOR EACH ROW EXECUTE FUNCTION rekoda_private.jobs_settlement_transition_guard()`,
    ],
    [
      'the refund function back at 0243, blind to a time boundary of the allowance (round G)',
      migrationText('0243_refund_judges_the_allowance_after_the_counter_lock.sql').match(
        /CREATE OR REPLACE FUNCTION public\.subscription_record_refund\([\s\S]*?END \$function\$;/,
      )![0],
    ],
    [
      'the boundary function answering false, its rules kept in a comment (round G)',
      `CREATE OR REPLACE FUNCTION rekoda_private.pack_allowance_boundary_between(
         p_business uuid, p_unit text, p_from timestamptz, p_to timestamptz) RETURNS boolean
       LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $f$
       BEGIN
         RETURN false; /* b.plan_expires_at > p_from h.ends_at > p_from pv.effective_to > p_from */
       END $f$`,
    ],
    [
      'the boundary function made SECURITY DEFINER (round G)',
      'ALTER FUNCTION rekoda_private.pack_allowance_boundary_between(uuid, text, timestamptz, timestamptz) SECURITY DEFINER',
    ],
    [
      'the boundary function executable by the application (round G)',
      `GRANT USAGE ON SCHEMA rekoda_private TO rekoda_app;
       GRANT EXECUTE ON FUNCTION rekoda_private.pack_allowance_boundary_between(uuid, text, timestamptz, timestamptz) TO rekoda_app`,
    ],
    [
      'the boundary function executable by PUBLIC (round G)',
      'GRANT EXECUTE ON FUNCTION rekoda_private.pack_allowance_boundary_between(uuid, text, timestamptz, timestamptz) TO PUBLIC',
    ],
    [
      'the boundary function made VOLATILE with its body unchanged (round G)',
      'ALTER FUNCTION rekoda_private.pack_allowance_boundary_between(uuid, text, timestamptz, timestamptz) VOLATILE',
    ],
    [
      '0244 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0244_refund_refuses_across_a_time_boundary'",
    ],
    [
      '0243 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0243_refund_judges_the_allowance_after_the_counter_lock'",
    ],
    [
      '0242 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0242_settlement_job_transitions'",
    ],
  ])('prints f for %s', async (_label, tamper) => {
    expect(await smokeAfter(tamper)).toBe('f');
  });
});
