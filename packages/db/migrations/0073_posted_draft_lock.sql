-- Posted-draft lock (spec §9.5; F1, PR-042).
--
-- The ledger stays correct without this, which is what makes the omission
-- dangerous: the approval trail silently stops describing what was
-- approved. Post `DR Rent / CR Bank`, then edit the draft to say
-- `DR Advertising`, and nobody can tell what anyone approved. So: once
-- `posted_journal_id` is set, the draft and every one of its lines are
-- read-only, enforced by trigger.
--
-- The lock binds the RUNTIME roles only. The owner is operator surface —
-- migrations, and the right-to-erasure function (0022), which deletes a
-- business's drafts along with the business; a lock that broke erasure
-- would be holding the trail of a chart that no longer exists.

CREATE OR REPLACE FUNCTION journal_draft_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user NOT IN ('rekoda_app', 'rekoda_worker') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF OLD.posted_journal_id IS NOT NULL THEN
    RAISE EXCEPTION 'draft % is posted and read-only (spec %)', OLD.id, '9.5'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER journal_draft_lock
  BEFORE UPDATE OR DELETE ON journal_drafts
  FOR EACH ROW
  EXECUTE FUNCTION journal_draft_locked();

CREATE OR REPLACE FUNCTION journal_draft_lines_locked()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  posted uuid;
BEGIN
  IF current_user NOT IN ('rekoda_app', 'rekoda_worker') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  SELECT d.posted_journal_id INTO posted
  FROM journal_drafts d
  WHERE d.business_id = COALESCE(NEW.business_id, OLD.business_id)
    AND d.id = COALESCE(NEW.draft_id, OLD.draft_id);
  IF posted IS NOT NULL THEN
    RAISE EXCEPTION 'draft % is posted and its lines are read-only (spec %)',
      COALESCE(NEW.draft_id, OLD.draft_id), '9.5'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER journal_draft_lines_lock
  BEFORE INSERT OR UPDATE OR DELETE ON journal_draft_lines
  FOR EACH ROW
  EXECUTE FUNCTION journal_draft_lines_locked();
