/**
 * The staging pre-start smoke for the second independent review of PR #432 (migrations 0231 to
 * 0237): it prints `f` for each way those guarantees can be undone. The harness is shared with
 * `deploy-smoke-sql.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { migrationText, smokeAfter, useSmokeHarness } from './deploy-smoke-sql.fixtures.js';

useSmokeHarness();

describe('the pre-start database smoke, second review (0231 to 0237)', () => {
  it('prints t for the migrated boundary', async () => {
    expect(await smokeAfter('')).toBe('t');
  });

  it.each([
    [
      'settlement able to run job_payload again (R01)',
      'GRANT EXECUTE ON FUNCTION job_payload(uuid) TO rekoda_settlement',
    ],
    [
      'job_payload back at 0228 (any state, R07)',
      readFileSync(
        new URL(
          '../../migrations/0228_worker_reads_no_payload_across_tenants.sql',
          import.meta.url,
        ),
        'utf8',
      ).match(/CREATE OR REPLACE FUNCTION public\.job_payload\([\s\S]*?\$\$;/)![0],
    ],
    [
      'the 0230 refund function back beside the 0235 one (R06)',
      `CREATE FUNCTION public.subscription_record_refund(p_business uuid, p_reference text,
         p_amount bigint, p_reason text, p_actor text)
       RETURNS TABLE (status text, refunded_k bigint, revoked_units integer)
       LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
       AS 'SELECT NULL::text, 0::bigint, 0'`,
    ],
    [
      'the provider refund id no longer unique (R06)',
      'DROP INDEX subscription_refunds_provider_refund_ux',
    ],
    [
      'the application able to insert a refund row (R06)',
      'GRANT INSERT ON subscription_refunds TO rekoda_app',
    ],
    [
      'the support-review price lookup without the annual fallback (R02)',
      `CREATE OR REPLACE FUNCTION rekoda_private.review_plan_price(p_business uuid, p_plan text,
         p_interval text, p_at timestamptz) RETURNS bigint LANGUAGE sql STABLE
       SET search_path = pg_catalog, pg_temp AS 'SELECT NULL::bigint'`,
    ],
    [
      'the requeue actor rule back at 0229 (R05)',
      migrationText('0229_dead_job_enrolment_dead_letter.sql').match(
        /CREATE OR REPLACE FUNCTION public\.dead_job_enrolment_requeue\([\s\S]*?END \$\$;/,
      )![0],
    ],
    [
      'the enrolment cursor executable by the application (R08)',
      'GRANT EXECUTE ON FUNCTION dead_job_unrecorded_candidates(integer, uuid) TO rekoda_app',
    ],
    [
      'settlement without its fingerprint read (G4b-2)',
      'REVOKE SELECT ON key_fingerprints FROM rekoda_settlement',
    ],
    [
      'the charge guard back at 0230 (credit columns preset on insert, G1-1)',
      migrationText('0230_refund_through_the_operator.sql').match(
        /CREATE OR REPLACE FUNCTION rekoda_private\.subscription_charges_settlement_guard\(\)[\s\S]*?END \$function\$;/,
      )![0],
    ],
    [
      '0237 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0237_settlement_reads_key_fingerprints'",
    ],
    [
      '0236 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0236_dead_job_enrolment_cursor'",
    ],
    [
      '0235 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0235_refund_records_and_pack_eligibility'",
    ],
    [
      '0234 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0234_job_payload_live_or_dying_only'",
    ],
    [
      '0233 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0233_operator_actor_contract'",
    ],
    [
      '0232 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0232_support_review_prices_like_the_resolver'",
    ],
    [
      '0231 not recorded in the ledger',
      "DELETE FROM rekoda_migrations WHERE tag = '0231_settlement_reads_only_its_kinds_payload'",
    ],
  ])('prints f for %s', async (_label, tamper) => {
    expect(await smokeAfter(tamper)).toBe('f');
  });
});
