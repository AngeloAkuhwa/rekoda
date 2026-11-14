-- Final review of PR #432 (14 Nov 2026, Qodo finding 10): settlement can no longer hold an add-on.
--
-- 0202 gave `rekoda_settlement` the right to record add-on holdings ("a sold entitlement, recorded
-- by settlement alone"), and 0217 kept it as INSERT and UPDATE on `business_add_ons`. No path in
-- the application sells or holds an add-on (`addOnsRepo.hold` has no caller), yet a holding raises
-- the metered ceiling: `usage_entitlement` (0222) adds every MONTHLY_UNITS grant of an active
-- holding (for example the 25,000 API requests of `developer_api_starter`, 0113). A holder of the
-- settlement credential could therefore raise any business's allowance with no paid charge behind
-- it, the hole 0224 closed for packs.
--
-- After this migration no runtime role writes `business_add_ons`; settlement keeps its SELECT (the
-- entitlement it reads). When an add-on is first sold, its holding must be written by a narrow
-- SECURITY DEFINER function bound to a paid charge, as `usage_credit_pack` is for packs (OD-51.4).
--
-- Compatibility: the previous release (main, 0192) has no settlement process, and this release's
-- settlement never writes the table. Not compatibility-breaking. Rollback: re-grant. Re-running is
-- safe.

REVOKE INSERT, UPDATE ON business_add_ons FROM rekoda_settlement;
