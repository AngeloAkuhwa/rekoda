-- Tie a migration run to the exact report that was approved (PR-120).
--
-- 0057 gave `migration_manifests` a `source_report_reference` and an
-- `item_set_checksum`. Between them they nearly answer "did this run do
-- what the approved report said it would", and the gap is the report
-- ITSELF: a reference is a name somebody types, and two files can carry the
-- same name and different numbers. A dispute six months later - "the
-- backfill touched rows we never approved" - is settled by comparing
-- bytes, not by trusting a label.
--
-- Three columns, each answering a question the others cannot:
--
--   source_report_sha256   the bytes of the approved report. Changed by one
--                          character and it no longer matches.
--   classifier_sha256      the bytes of the CLASSIFIER that produced it. A
--                          report is only as reproducible as the script
--                          behind it; without this, re-running to check a
--                          number may silently use a different ladder.
--   approved_by_user_id    the approver as an immutable internal UUID
--                          (owner ruling, 28 Aug 2026). `approved_by` stays
--                          for the human-readable note, but a display name
--                          or an email address is not an identity: people
--                          are renamed, addresses are reassigned, and the
--                          one thing that must still resolve in five years
--                          is who approved it.

ALTER TABLE migration_manifests
  ADD COLUMN source_report_sha256 text
    CONSTRAINT migration_manifests_report_sha CHECK (
      source_report_sha256 IS NULL OR source_report_sha256 ~ '^[0-9a-f]{64}$'
    ),
  ADD COLUMN classifier_sha256 text
    CONSTRAINT migration_manifests_classifier_sha CHECK (
      classifier_sha256 IS NULL OR classifier_sha256 ~ '^[0-9a-f]{64}$'
    ),
  ADD COLUMN approved_by_user_id uuid;

/* Nullable, and the CHECKs allow null, because a manifest is opened before
 * it is approved and because not every migration in this table is
 * report-gated. What is NOT allowed is a half-recorded approval: a run
 * claiming an approver with no report fingerprint, or a fingerprint with
 * nobody's name on it, is the shape a fabricated approval takes. */
ALTER TABLE migration_manifests
  ADD CONSTRAINT migration_manifests_approval_complete CHECK (
    (approved_by_user_id IS NULL AND source_report_sha256 IS NULL)
    OR (approved_by_user_id IS NOT NULL AND source_report_sha256 IS NOT NULL)
  );

COMMENT ON COLUMN migration_manifests.source_report_sha256 IS
  'SHA-256 of the approved report file, hex. Settles "was this the report '
  'that was signed off" by bytes rather than by a typed reference.';
COMMENT ON COLUMN migration_manifests.classifier_sha256 IS
  'SHA-256 of the read-only classifier that produced the report, so the '
  'numbers can be reproduced with the same ladder that made them.';
COMMENT ON COLUMN migration_manifests.approved_by_user_id IS
  'The approver as an immutable internal operator UUID (owner ruling, 28 '
  'Aug 2026). A name or an email address is not an identity.';
