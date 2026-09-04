-- A checkout breakdown that reads back in the order it was written.
--
-- Same defect, same fix as 0146, on the customer-facing table. `now()` is
-- TRANSACTION START time, so every charge a checkout records in its one
-- transaction lands on the same instant, and `chargesForOrder` ordered by
-- that column alone. PostgreSQL was free to return the lines in any order,
-- and an UPDATE makes it exercise that freedom: `resolveChargeActual` writes
-- a new row version at the end of the heap when a settlement replaces the
-- estimated fee with the actual one, which is exactly when a tied breakdown
-- would reshuffle under the customer's receipt.
--
-- Today this is latent rather than live: the one production writer records a
-- single PAYMENT_PROCESSING charge per order, so no real order has a tie
-- yet. That is the right time to fix it - the table's whole design is
-- "every line of a checkout breakdown as a record", and the second line
-- type written in the same transaction would have made the order arbitrary.
--
-- `clock_timestamp()` advances between statements, so the column means what
-- the reader assumed. `updated_at` moves with it, or a fresh charge would
-- claim it was modified before it existed - `created_at` from the wall
-- clock, `updated_at` from transaction start. Rows written before this
-- migration keep their ties; the reader resolves them deterministically on
-- `id`, which cannot recover a true order that was never recorded and does
-- not pretend to.

ALTER TABLE payment_charges ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE payment_charges ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
