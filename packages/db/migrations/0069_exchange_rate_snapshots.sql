-- ExchangeRateSnapshot and the FX requirement (spec §16, Appendix A.1;
-- F1, PR-038).
--
-- The snapshot is a market fact, not tenant data: no business_id, no RLS.
-- What makes it safe to share is what makes it a snapshot — immutable once
-- written (UPDATE and DELETE revoked from both runtime roles), stored at
-- full provider precision, stamped with the moment the rate APPLIES TO
-- rather than the moment it was fetched. A manual override is a decision,
-- so it carries who decided and why, by CHECK rather than by convention.

CREATE TABLE exchange_rate_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency      char(3) NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
  quote_currency     char(3) NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
  /* Full provider precision, never rounded (A.1). */
  rate               numeric NOT NULL CHECK (rate > 0),
  /* The moment the rate applies to, not fetch time. */
  effective_at       timestamptz NOT NULL,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  source             text NOT NULL CHECK (source IN ('PROVIDER', 'MANUAL_OVERRIDE', 'INHERITED')),
  provider_name      text NOT NULL,
  provider_reference text,
  actor_id           text,
  reason             text,
  created_at         timestamptz NOT NULL DEFAULT now(),

  /* An override is a human decision: who, and why, or it is not one. */
  CONSTRAINT exchange_rate_override_accounted CHECK (
    source <> 'MANUAL_OVERRIDE' OR (actor_id IS NOT NULL AND reason IS NOT NULL)
  ),
  CONSTRAINT exchange_rate_pair_distinct CHECK (base_currency <> quote_currency)
);

CREATE INDEX exchange_rate_snapshots_pair_ix
  ON exchange_rate_snapshots (base_currency, quote_currency, effective_at DESC);

/* Immutable once written. */
REVOKE UPDATE, DELETE ON exchange_rate_snapshots FROM rekoda_app;
REVOKE UPDATE, DELETE ON exchange_rate_snapshots FROM rekoda_worker;

/* The ledger's reference becomes real. */
ALTER TABLE ledger_entries
  ADD CONSTRAINT ledger_entries_fx_snapshot_fk
  FOREIGN KEY (exchange_rate_snapshot_id) REFERENCES exchange_rate_snapshots (id);

/* ── the FX requirement (§16, §10) ──────────────────────────────────────
 * A snapshot exists exactly when the transaction currency differs from the
 * entry's functional currency: REQUIRED when they differ, FORBIDDEN when
 * equal (the rate is 1 by definition, and a stored rate of anything else
 * would be a lie that balances). When present, the snapshot must actually
 * be for this pair — a USD line citing a GBP rate is the §10 coherence
 * failure this trigger exists to make unrepresentable. */
CREATE OR REPLACE FUNCTION ledger_enforce_fx_requirement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  fc    char(3);
  base  char(3);
  quote char(3);
BEGIN
  SELECT t.functional_currency INTO fc
  FROM ledger_transactions t
  WHERE t.id = NEW.transaction_id AND t.business_id = NEW.business_id;

  IF NEW.transaction_currency = fc THEN
    IF NEW.exchange_rate_snapshot_id IS NOT NULL THEN
      RAISE EXCEPTION
        'same-currency line must not carry a rate snapshot: the rate is 1 by definition (spec %)', '16'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.exchange_rate_snapshot_id IS NULL THEN
    RAISE EXCEPTION
      'cross-currency line (% into %) needs an exchange rate snapshot (spec %)',
      NEW.transaction_currency, fc, '16'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.base_currency, s.quote_currency INTO base, quote
  FROM exchange_rate_snapshots s
  WHERE s.id = NEW.exchange_rate_snapshot_id;
  IF base IS DISTINCT FROM NEW.transaction_currency OR quote IS DISTINCT FROM fc THEN
    RAISE EXCEPTION
      'exchange rate snapshot is for %/% but the line converts % into % (spec %)',
      base, quote, NEW.transaction_currency, fc, '16'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ledger_entry_fx_requirement
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_enforce_fx_requirement();
