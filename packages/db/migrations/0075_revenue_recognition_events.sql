-- RevenueRecognitionEvent and its idempotency, plus the review queue for
-- atomic refusals (spec §12.2, §12.5; F1, PR-045).
--
-- Two tables the recognition wiring (PR-046, schema-free) will stand on:
--
--   revenue_recognition_events    what has been recognised, per order —
--                                 §12.2's revenueRecognisedToDate is the
--                                 SUM of these rows, read from here at
--                                 posting time, never cached. Idempotent
--                                 by §12.5's exact quadruple.
--   recognition_review_items      the REQUIRES_REVIEW refusals. Machine-
--                                 readable reason (an enum, never one
--                                 undifferentiated bucket), full source
--                                 context retained — because the refusal
--                                 must be REPLAYABLE: nothing was posted
--                                 and nothing was lost.

/* The composite target the order FKs below need. */
ALTER TABLE orders ADD CONSTRAINT orders_business_id_ux UNIQUE (business_id, id);

CREATE TABLE revenue_recognition_events (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            uuid NOT NULL REFERENCES businesses (id),
  order_id               uuid NOT NULL,
  order_line_id          uuid,
  source_type            text NOT NULL,
  source_id              text NOT NULL,
  /* REVENUE only. Never gross. Never VAT-inclusive (§12.5). */
  amount_minor           bigint NOT NULL CHECK (amount_minor >= 0),
  /* The balanced journal this recognition produced. */
  ledger_transaction_id  uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT rre_order_fk
    FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id),
  CONSTRAINT rre_ledger_fk
    FOREIGN KEY (business_id, ledger_transaction_id)
    REFERENCES ledger_transactions (business_id, id)
);

/* The §12.5 idempotency key, with NULL order lines pinned to a sentinel so
 * an order-level fulfilment cannot recognise twice either. */
CREATE UNIQUE INDEX rre_idempotency_ux
  ON revenue_recognition_events (
    business_id, source_type, source_id,
    coalesce(order_line_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

CREATE INDEX rre_order_ix ON revenue_recognition_events (business_id, order_id);

ALTER TABLE revenue_recognition_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE revenue_recognition_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON revenue_recognition_events
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* What has been recognised is history. */
REVOKE UPDATE, DELETE ON revenue_recognition_events FROM rekoda_app;
REVOKE UPDATE, DELETE ON revenue_recognition_events FROM rekoda_worker;

CREATE TABLE recognition_review_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses (id),
  order_id      uuid,
  review_reason text NOT NULL CHECK (review_reason IN ('UNSUPPORTED_CONTRACT_ASSET')),
  source_type   text NOT NULL,
  source_id     text NOT NULL,
  /* The full context at the moment of refusal: the computed delta and the
   * balances the engine saw. What makes the backlog clearable
   * deterministically later. */
  context       jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  resolved_by   text,

  CONSTRAINT review_resolution_pair CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  CONSTRAINT review_order_fk
    FOREIGN KEY (business_id, order_id) REFERENCES orders (business_id, id),
  /* One OPEN item per refused event: replaying the same refusal is not a
   * second thing for a human to look at. */
  CONSTRAINT review_open_once UNIQUE (business_id, source_type, source_id, review_reason)
);

CREATE INDEX review_items_open_ix
  ON recognition_review_items (business_id) WHERE resolved_at IS NULL;

ALTER TABLE recognition_review_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE recognition_review_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recognition_review_items
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid)
  WITH CHECK (business_id = nullif(current_setting('app.business_id', true), '')::uuid);

/* Resolving marks; nothing deletes. */
REVOKE DELETE ON recognition_review_items FROM rekoda_app;
REVOKE DELETE ON recognition_review_items FROM rekoda_worker;
