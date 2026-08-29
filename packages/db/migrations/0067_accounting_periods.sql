-- The accounting-period table (spec §8; F1, PR-036).
--
-- Until now `businesses.books_closed_through` was the entire period model:
-- one scalar watermark. The watermark SEMANTICS were right — closing is
-- monotonic, "closed through August" is a fact a merchant can hold in their
-- head — and they survive whole. What changes is the record: each closed
-- month becomes a ROW that knows when it closed, who closed it, and whether
-- it was reopened, which is what §10's "the accounting period is open"
-- trigger, the kernel and every later per-month feature stand on.
--
-- A month is closed exactly when a row with status = 'closed' says so, and
-- the watermark is now DERIVED: MAX(period) over closed rows. Reopening
-- flips rows rather than deleting them — the fact that a month was once
-- closed is history, and history is kept.

CREATE TABLE accounting_periods (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses (id),
  /* Lagos month, YYYY-MM. Lagos is UTC+1 all year; the month a posting
   * falls in never turns on an hour. */
  period       char(7) NOT NULL CHECK (period ~ '^\d{4}-\d{2}$'),
  status       text NOT NULL CHECK (status IN ('closed', 'open')),
  closed_at    timestamptz NOT NULL DEFAULT now(),
  closed_by    text NOT NULL,
  reopened_at  timestamptz,
  reopened_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),

  /* A closed row has no reopening; an open row is one that was reopened —
   * a month never closed has no row at all. */
  CONSTRAINT accounting_periods_status_coherent
    CHECK ((status = 'closed') = (reopened_at IS NULL)),
  CONSTRAINT accounting_periods_reopen_pair
    CHECK ((reopened_at IS NULL) = (reopened_by IS NULL)),

  CONSTRAINT accounting_periods_business_period_ux UNIQUE (business_id, period)
);

/* The trigger's read: the watermark, straight off an index. */
CREATE INDEX accounting_periods_closed_ix
  ON accounting_periods (business_id, period DESC)
  WHERE status = 'closed';

ALTER TABLE accounting_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounting_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON accounting_periods
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* Reopening flips a row; nothing deletes one. */
REVOKE DELETE ON accounting_periods FROM rekoda_app;
REVOKE DELETE ON accounting_periods FROM rekoda_worker;

/* ── migrate the watermark into rows ────────────────────────────────────
 * One closed row per month from the business's earliest ledger activity
 * (or the watermark month itself, whichever is earlier — a business with
 * no postings still keeps its close) through the watermark. */
INSERT INTO accounting_periods (business_id, period, status, closed_by)
SELECT b.id, gs.period, 'closed', 'migration:0067'
FROM businesses b
CROSS JOIN LATERAL (
  SELECT to_char(m, 'YYYY-MM') AS period
  FROM generate_series(
    LEAST(
      COALESCE(
        (SELECT date_trunc('month', MIN(t.created_at AT TIME ZONE 'Africa/Lagos'))::date
         FROM ledger_transactions t WHERE t.business_id = b.id),
        to_date(b.books_closed_through || '-01', 'YYYY-MM-DD')
      ),
      to_date(b.books_closed_through || '-01', 'YYYY-MM-DD')
    ),
    to_date(b.books_closed_through || '-01', 'YYYY-MM-DD'),
    interval '1 month'
  ) AS m
) gs
WHERE b.books_closed_through IS NOT NULL
ON CONFLICT (business_id, period) DO NOTHING;

/* ── the gate (validated, not hoped — the 0064 pattern) ─────────────────
 * Before the column drops, every watermark must be re-derivable from the
 * rows: MAX(closed period) equals the scalar it replaces, per business. */
DO $$
DECLARE
  broken bigint;
BEGIN
  SELECT count(*) INTO broken
  FROM businesses b
  WHERE b.books_closed_through IS NOT NULL
    AND (SELECT MAX(p.period) FROM accounting_periods p
         WHERE p.business_id = b.id AND p.status = 'closed')
        IS DISTINCT FROM b.books_closed_through;
  IF broken > 0 THEN
    RAISE EXCEPTION
      'accounting_periods migration incomplete: % businesses whose derived watermark disagrees',
      broken;
  END IF;
END;
$$;

/* ── the trigger reads the table now ────────────────────────────────────
 * Same refusal, same message, same invoker-rights reasoning as 0034: the
 * inserting transaction is necessarily pinned to NEW.business_id, which is
 * exactly what the accounting_periods policy admits. */
CREATE OR REPLACE FUNCTION ledger_refuse_closed_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  closed_through text;
  falls_in       text;
BEGIN
  SELECT MAX(p.period) INTO closed_through
  FROM accounting_periods p
  WHERE p.business_id = NEW.business_id AND p.status = 'closed';

  IF closed_through IS NULL THEN
    RETURN NEW;
  END IF;

  falls_in := to_char(NEW.created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM');

  IF falls_in <= closed_through THEN
    RAISE EXCEPTION
      'books are closed through % and this entry falls in %',
      closed_through, falls_in
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

/* The scalar goes. Its four readers cut over to the table in the same
 * deploy, and the gate above proved nothing is lost in the derivation. */
ALTER TABLE businesses DROP COLUMN books_closed_through;
