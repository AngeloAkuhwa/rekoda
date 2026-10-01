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

-- WHICH retired question a funding-answer rebuild was built from. A short
-- "bank" rebuilds the purchase as a pending preview; if the purchase is then
-- sent again (by any member: the base way to answer the question), that NEW
-- preview is the purchase now, and the older rebuilt preview is superseded
-- in the same transaction, so two yeses can never book the purchase twice.
-- Explicit, never inferred from states or from the model column.
ALTER TABLE command_drafts ADD COLUMN rebuilt_from uuid;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_rebuilt_from_business_fk
  FOREIGN KEY (business_id, rebuilt_from) REFERENCES command_drafts (business_id, id);
