-- One real purchase, one financial truth (G-81, OD-23).
--
-- A "yes" confirms the newest pending draft of the whole business, and
-- nothing compared a new purchase with one already waiting or booked. Two
-- previews of one real purchase, or a purchase sent again after it was
-- booked, could therefore be booked twice: across members, or by one member
-- through a double-send or a double-tap.
--
-- A purchase that may be one already waiting or booked in the last 24 hours
-- (OD-23 D1, D2) is now ASKED about, never silently dropped and never
-- silently booked. Its draft is HELD: kept on the record, never confirmable,
-- and the member is asked "same or separate" through a typed continuation
-- naming it. "same" closes it and writes nothing; "separate" builds a FRESH
-- preview with its own G-23 window, which only a normal "yes" confirms.
--
-- Nothing here stores a fingerprint. The comparison reads columns that
-- already exist (the stored command's amount and its reference, kept as a
-- document KIND from a closed set and its digits, never letters, "INV:2231";
-- the product row a booked purchase moved, and whether it is
-- catalogue-linked, the only trusted product identity under owner ruling
-- D3, dormant while nothing writes `external_catalogue_id`) and opaque ids;
-- no supplier, product or customer text is copied anywhere. A supplier row
-- never proves two purchases separate.

-- A held purchase: asked "same or separate", never confirmable, never moved
-- by the G-23 sweep (which moves only `pending`). Its `expires_at` is the
-- question's window, not a confirmation window: an answer after it attaches
-- to nothing.
ALTER TABLE command_drafts DROP CONSTRAINT command_drafts_state_check;
ALTER TABLE command_drafts ADD CONSTRAINT command_drafts_state_check
  CHECK (state IN ('pending', 'superseded', 'confirmed', 'abandoned', 'expired', 'held'));

-- The held purchase a fresh preview was declared separate from (the answer
-- "separate"). Read for one thing: a record that question NAMED
-- (`asked_about_drafts`, `asked_about_expenses` below) is not this
-- purchase, in either direction, at preview time and at the yes. Composite tenant key (the 0141 pattern); never its own source.
ALTER TABLE command_drafts ADD COLUMN separate_from uuid;

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_separate_from_business_fk
  FOREIGN KEY (business_id, separate_from) REFERENCES command_drafts (business_id, id);

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_separate_from_check
  CHECK (separate_from IS NULL OR (intent = 'RecordPurchase' AND separate_from <> id));

-- EXACTLY which records the identity question about a held purchase named
-- (fresh review of #262): their drafts and their bookings, as opaque ids. A
-- "separate" answer excuses those records and nothing else; a record the
-- question did not name is asked about. A re-asked question adds the record
-- it newly names. Set only on a held purchase, and kept after it is
-- answered, so the fresh preview it built stays separate from them at the
-- yes. Opaque ids only: no text, no amount, no fingerprint.
ALTER TABLE command_drafts ADD COLUMN asked_about_drafts uuid[];
ALTER TABLE command_drafts ADD COLUMN asked_about_expenses uuid[];

ALTER TABLE command_drafts
  ADD CONSTRAINT command_drafts_asked_about_check
  CHECK ((asked_about_drafts IS NULL AND asked_about_expenses IS NULL)
         OR intent = 'RecordPurchase');

-- When the question was last RE-ASKED with a record added to what it names
-- (Codex review of 30a5c8f), on the database clock. A "separate" sent
-- before it answered the question as it then stood, so it never excuses
-- what the re-ask added: it is asked again. Null until a re-ask.
ALTER TABLE command_drafts ADD COLUMN reasked_at timestamptz;

-- The identity question as a continuation: it names the held draft and
-- nothing else, exactly as a funding-source question names its retired one.
-- The 0155 constraint keeps its name (it now covers both questions about a
-- draft), so what refers to it by name still finds it.
ALTER TABLE conversation_continuations
  DROP CONSTRAINT conversation_continuations_expects_check;
ALTER TABLE conversation_continuations
  ADD CONSTRAINT conversation_continuations_expects_check
  CHECK (expects IN ('period', 'choice', 'funding_source', 'purchase_identity'));

ALTER TABLE conversation_continuations
  DROP CONSTRAINT conversation_continuations_funding_shape_check;
ALTER TABLE conversation_continuations
  ADD CONSTRAINT conversation_continuations_funding_shape_check CHECK (
    (expects IS NOT DISTINCT FROM 'funding_source' OR expects IS NOT DISTINCT FROM 'purchase_identity')
      = (draft_id IS NOT NULL)
    AND (draft_id IS NULL OR (topic IS NULL AND options IS NULL))
  );

-- One continuation per message, per member, per EXPECTED ANSWER (Codex
-- review). A funding answer ("cash") whose rebuilt purchase is held opens
-- the identity question on that message; if the question is never delivered,
-- the funding question is given back on the same message, and 0156's
-- (message, member) unique made that impossible: the retired identity row
-- stood in its place. A replay still finds its own row. Rows are still never
-- reopened.
DROP INDEX conversation_continuations_message_ux;
CREATE UNIQUE INDEX conversation_continuations_message_ux
  ON conversation_continuations (source_message_id, user_id, (coalesce(expects, '')));

-- The booked purchases one total can collide with: read at preview time
-- (inside the business's inbound lock, by message order) and by the
-- purchase work at the yes, under the identity lock.
CREATE INDEX expenses_purchase_identity_ix
  ON expenses (business_id, amount_k, created_at)
  WHERE category = 'stock';
