-- Accounts payable and the bill lifecycle (spec §8, §12; F2, PR-077).
--
-- The payable side finally gets its DOCUMENT. Since the spend slice, a
-- credit purchase has raised ACCOUNTS_PAYABLE and everything about the
-- debt — how much stands, how old it is, which payment cleared it — has
-- been arithmetic over the expense row, its posting and
-- supplier_payments. The arithmetic is honest (the ageing derives from
-- the ledger and nets attributed payments), but a debt with no document
-- has no number an accountant can write down, no due date anybody
-- agreed, and no lifecycle a page can show. A bill is the mirror of an
-- invoice, pointing the other way.
--
-- The lifecycle is CONSTRAINED, not narrated: a status that disagrees
-- with the money is unrepresentable, and the balance is a GENERATED
-- column so no writer can let paid and due drift apart.

/* The composite FK targets the tenant-safe shape every scope column
 * uses (0061's lesson): a bill cannot cite another tenant's expense or
 * supplier. */
ALTER TABLE expenses
  ADD CONSTRAINT expenses_business_id_ux UNIQUE (business_id, id);
ALTER TABLE suppliers
  ADD CONSTRAINT suppliers_business_id_ux UNIQUE (business_id, id);

CREATE TABLE bills (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id             uuid NOT NULL REFERENCES businesses(id),
  /* Who is owed. Nullable: a purchase recorded without naming a supplier
   * is still a debt, just an unaddressed one. */
  supplier_id             uuid,
  /* The spend row whose posting raised the payable. One bill per row. */
  expense_id              uuid NOT NULL,
  /* BILL-2026-000041, on its own counter (doc_counters kind 'bill'). */
  bill_number             text NOT NULL,
  /* The supplier's own reference for it, when the merchant has one. */
  supplier_reference      text,
  status                  text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'partially_paid', 'paid', 'voided')),
  /* The CREDIT portion — what the posting raised on ACCOUNTS_PAYABLE,
   * not the whole purchase. A part-cash purchase bills only the part
   * still owed. */
  total_k                 bigint NOT NULL CHECK (total_k > 0),
  paid_k                  bigint NOT NULL DEFAULT 0
    CHECK (paid_k >= 0 AND paid_k <= total_k),
  balance_due_k           bigint GENERATED ALWAYS AS (total_k - paid_k) STORED,
  billed_on               date NOT NULL,
  /* Nullable, honestly: Rekoda never invents terms a supplier did not
   * set. The ageing keeps ageing by how long the debt has STOOD. */
  due_date                date,
  /* The raising posting, so a void knows exactly what it reverses. */
  ledger_transaction_id   uuid,
  source_type             text NOT NULL,
  source_id               text,
  created_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bills_business_id_ux UNIQUE (business_id, id),
  CONSTRAINT bills_number_ux UNIQUE (business_id, bill_number),
  CONSTRAINT bills_expense_ux UNIQUE (business_id, expense_id),
  CONSTRAINT bills_expense_fk
    FOREIGN KEY (business_id, expense_id) REFERENCES expenses (business_id, id),
  CONSTRAINT bills_supplier_fk
    FOREIGN KEY (business_id, supplier_id) REFERENCES suppliers (business_id, id),
  /* A status that disagrees with the money cannot be written. */
  CONSTRAINT bills_status_coherent CHECK (
    (status = 'open' AND paid_k = 0)
    OR (status = 'partially_paid' AND paid_k > 0 AND paid_k < total_k)
    OR (status = 'paid' AND paid_k = total_k)
    OR (status = 'voided')
  )
);

CREATE INDEX bills_business_status_ix ON bills (business_id, status);

ALTER TABLE bills ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bills
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* Which bill a payment settled — beside expense_id, not replacing it:
 * the expense attribution is what the ageing has always read. */
ALTER TABLE supplier_payments
  ADD COLUMN bill_id uuid,
  ADD CONSTRAINT supplier_payments_bill_fk
    FOREIGN KEY (business_id, bill_id) REFERENCES bills (business_id, id);

/* ── backfill: every payable ever raised becomes a bill ────────────────
 * The raised amount is what the posting CREDITED on the payable account
 * (code 2000), the paid amount is what supplier_payments attributes, and
 * the status follows the money — with a voided spend row keeping its
 * bill voided. Numbered per business per Lagos year in creation order,
 * and the counters advanced so live numbering continues after the
 * backfill instead of colliding with it. */
CREATE TEMP TABLE bills_backfill_0098 AS
WITH raising AS (
  SELECT e.id AS expense_id, e.business_id, e.supplier_id, e.created_at,
         e.ledger_transaction_id, e.status AS spend_status,
         SUM(le.credit_k - le.debit_k) AS raised_k,
         EXTRACT(YEAR FROM (e.created_at AT TIME ZONE 'Africa/Lagos'))::int AS yr
  FROM expenses e
  JOIN ledger_entries le
    ON le.business_id = e.business_id AND le.transaction_id = e.ledger_transaction_id
  JOIN accounts acc ON acc.id = le.account_id
  WHERE acc.code = '2000'
  GROUP BY e.id
  HAVING SUM(le.credit_k - le.debit_k) > 0
)
SELECT r.*,
       row_number() OVER (
         PARTITION BY r.business_id, r.yr ORDER BY r.created_at, r.expense_id
       ) AS seq,
       LEAST(
         r.raised_k,
         COALESCE((SELECT SUM(sp.amount_k) FROM supplier_payments sp
                   WHERE sp.business_id = r.business_id
                     AND sp.expense_id = r.expense_id), 0)
       ) AS settled_k
FROM raising r;

INSERT INTO bills
  (business_id, supplier_id, expense_id, bill_number, status, total_k, paid_k,
   billed_on, ledger_transaction_id, source_type, source_id, created_at)
SELECT business_id, supplier_id, expense_id,
       'BILL-' || yr || '-' || lpad(seq::text, 6, '0'),
       CASE
         WHEN spend_status = 'voided' THEN 'voided'
         WHEN settled_k = raised_k THEN 'paid'
         WHEN settled_k > 0 THEN 'partially_paid'
         ELSE 'open'
       END,
       raised_k, settled_k,
       (created_at AT TIME ZONE 'Africa/Lagos')::date,
       ledger_transaction_id, 'backfill_0098', expense_id::text, created_at
FROM bills_backfill_0098;

INSERT INTO doc_counters (business_id, doc_type, year, last_seq)
SELECT business_id, 'bill', yr, MAX(seq) FROM bills_backfill_0098 GROUP BY business_id, yr
ON CONFLICT (business_id, doc_type, year) DO UPDATE
  SET last_seq = GREATEST(doc_counters.last_seq, EXCLUDED.last_seq);

DROP TABLE bills_backfill_0098;

UPDATE supplier_payments sp
SET bill_id = b.id
FROM bills b
WHERE b.business_id = sp.business_id AND b.expense_id = sp.expense_id;

/* The 0064-shape gate: a payable the backfill missed, or a payment left
 * unattributed to its bill, fails the migration rather than surviving it. */
DO $$
DECLARE missing integer;
BEGIN
  SELECT count(*) INTO missing
  FROM supplier_payments sp
  WHERE sp.bill_id IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'bills backfill left % supplier_payments rows without a bill', missing;
  END IF;
END $$;
