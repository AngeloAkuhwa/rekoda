-- WHO drafted a preview, and WHAT a rebuilt preview was built from (G-68,
-- final-head review).
--
-- The merchant thread is one per business, shared by every member, and a
-- message row does not say who sent it (the provider payload is sealed). So
-- when a member's short funding answer ("cash") cannot rebuild anything
-- because a preview is already waiting, Rekoda could not tell whether THAT
-- member had ever seen the preview. Telling a delegate "a preview is already
-- waiting: check it, then reply yes" about the owner's Bank preview invites
-- the delegate to book a purchase from an account they did not choose.
--
-- This column records the member whose message drafted the row, set at the
-- only INSERT when the sender is a member. "Already waiting" is said only of
-- the member's OWN live, reachable preview; a row without it (older drafts,
-- or a sender who is not a member) is never claimed as theirs.

ALTER TABLE command_drafts ADD COLUMN requested_by uuid REFERENCES users (id);

-- WHICH retired question a funding-answer rebuild was built from. Read for
-- two things only: "a preview is already waiting" is said only of the
-- purchase rebuilt from the very question a later short answer was about;
-- and when the SAME member who drafted a pending rebuild records a new
-- purchase preview of the same total (integer kobo), the rebuild is
-- superseded and the reply says so, so that member's two yeses cannot book
-- one purchase twice. Never across members. Explicit, never inferred from
-- states or from the model column. A draft is never its own source.
ALTER TABLE command_drafts ADD COLUMN rebuilt_from uuid;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_rebuilt_from_business_fk
  FOREIGN KEY (business_id, rebuilt_from) REFERENCES command_drafts (business_id, id);

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_rebuilt_from_not_self_check
  CHECK (rebuilt_from IS NULL OR rebuilt_from <> id);

-- A preview WITHDRAWN because it never reached the merchant (Codex review).
-- A new purchase preview closes every older retired purchase question; if its
-- send then fails, nobody saw it, so it is withdrawn (superseded, and marked
-- here) and the questions it closed are restored. The marker is what keeps a
-- withdrawn preview from counting as a newer draft that blocks the restored
-- question, explicitly, never inferred from states. Only ever on a superseded
-- draft.
ALTER TABLE command_drafts ADD COLUMN withdrawn boolean NOT NULL DEFAULT false;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_withdrawn_superseded_check
  CHECK (NOT withdrawn OR state = 'superseded');
