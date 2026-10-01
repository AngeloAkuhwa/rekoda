-- WHICH member's message drafted a preview (G-68, final-head review).
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
