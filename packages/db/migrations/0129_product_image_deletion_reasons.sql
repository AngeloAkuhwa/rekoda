-- Product photos are two more reasons an object is owed to the bin.
--
-- 0122 built the queue for two: a business deleted, and evidence purged. Both
-- are sweeps. These two are not.
--
-- `image_replaced` is a merchant re-uploading a photo in the middle of an
-- ordinary afternoon. Nothing collected the object the new one displaced:
-- `setProductImage` handed the old key back so the caller could delete it, and
-- the caller dropped it. Every re-upload since has left bytes in the bucket
-- that no row names.
--
-- `upload_orphaned` is the other half, and a different fact worth telling an
-- operator apart from the first: bytes written to the bucket for an upload
-- that then failed, so they never had a row at all. Recording both as
-- "replaced" would make a queue full of failed writes read like a busy shop.
--
-- Widening the CHECK rather than editing 0122, which has shipped. The
-- constraint is dropped and re-added because that is the only way PostgreSQL
-- changes one, and it is validated against existing rows on the way back in -
-- which is free here, since every existing row already holds one of the two
-- values being kept.

ALTER TABLE pending_object_deletions
  DROP CONSTRAINT pending_object_deletions_reason_check;

ALTER TABLE pending_object_deletions
  ADD CONSTRAINT pending_object_deletions_reason_check
  CHECK (reason IN ('business_deleted', 'evidence_purged', 'image_replaced', 'upload_orphaned'));
