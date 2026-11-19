-- Second independent review of PR #432 (R01, BLOCKING; Codex P2 on 0228): settlement's payload reads
-- keep 0217's job-kind isolation.
--
-- 0228 granted EXECUTE on `job_payload(job)` to `rekoda_settlement` as well as `rekoda_worker`. The
-- function is SECURITY DEFINER and owned by the migrating role, so it is not subject to the RLS of
-- `jobs` and checks only the tenant pin. A holder of the settlement credential who knew any job's id
-- and business could therefore pin that business and read the payload of an `inbound.message`,
-- document or any other merchant job, which 0217's restrictive policy `settlement_only_its_kinds`
-- refuses it on a direct read. That reopened the separation 0217 established.
--
-- Since 0231 settlement may not execute `job_payload` at all. It needs no definer function: it
-- holds SELECT on `jobs` (0217), and that read is filtered by `settlement_claim` and the restrictive
-- `settlement_only_its_kinds` to `billing.process` and `billing.apply_no_charge`, so a payload of
-- any other kind is invisible to it whatever tenant it pins. The repository reads a payload through
-- `job_payload` only where the connected role may execute it (the worker), and otherwise through the
-- plain, RLS-filtered column read (`packages/db/src/repos/jobs.ts`, `pinnedPayload`).
--
-- Not a compatibility break: this release's settlement process already falls back to the column
-- read, and the previous release (main, 0192) has no settlement process. Re-running is safe.
-- Rollback: none needed; re-granting would reopen R01.

REVOKE EXECUTE ON FUNCTION public.job_payload(uuid) FROM rekoda_settlement;
REVOKE ALL ON FUNCTION public.job_payload(uuid)
  FROM PUBLIC, rekoda_app, rekoda_billing_operator, rekoda_settlement;
GRANT EXECUTE ON FUNCTION public.job_payload(uuid) TO rekoda_worker;

-- The guarantee is asserted here, so a migration that silently re-grants it fails the next deploy's
-- smoke rather than passing unnoticed.
DO $$
BEGIN
  IF has_function_privilege('rekoda_settlement', 'public.job_payload(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rekoda_settlement still executes job_payload (inherited membership?)';
  END IF;
END
$$;
