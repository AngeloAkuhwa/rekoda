-- Conversational continuation state (Build 6).
--
-- Rekoda understood each message on its own. When it asked a question back
-- ("How much did I sell?" -> "Which period?"), the merchant's short answer
-- ("Last month.") arrived with nothing to attach to, and was read as a
-- brand new message. This table is what a short reply attaches to.
--
-- It is NOT the financial confirmation state. A preview a "yes" confirms
-- is a `command_drafts` row with its own window (G-23) and its own atomic
-- claim; nothing here refers to, revives or claims a draft, and nothing a
-- row here resolves to is a write.
--
-- One row is one of two things, typed, never a transcript:
--
--   kind = 'clarification'  Rekoda asked ONE question the next reply may
--                           answer. `expects` says what an answer is:
--                             period  "today", "this week", "last month"...
--                             choice  an ordinal from an explicit numbered
--                                     list; `options` holds the exact
--                                     lines shown (invoice numbers only)
--                           One-shot: consumed by its answer, atomically.
--   kind = 'query'          the READ Rekoda just answered, as a subject a
--                           follow-up may continue: the topic, the window,
--                           a vault customer token, a document number.
--
-- No column holds words anybody typed. A customer is a vault token
-- (CUSTOMER_7K2), enforced by CHECK so a name can never be stored here by a
-- careless caller; a document is its number, which both sides already share.
--
-- ACTOR-SCOPED. A business can have several people on WhatsApp (owner,
-- delegate, accountant). One person's "last month" must never answer the
-- question Rekoda asked another, so every row belongs to the MEMBER who was
-- asked (`user_id`), and every read and claim names that member. The tenant
-- policy below scopes the business, as on every tenant table.
--
-- NEWEST WINS. At most one row per member is `open` (the partial unique
-- index): opening a new one retires the old one first. A reply that does not
-- fit what is open retires it too, so a purchase sent after "Which period?"
-- is a purchase, and the question is gone.
--
-- EXPIRY. `expires_at` is set from CONTINUATION_TTL_SECONDS
-- (packages/core/src/continuation.ts, 600 seconds). SQL cannot import the
-- constant, so the 600 in the default below is pinned to it by
-- continuations.integration.test.ts. A row past its window behaves as absent
-- for every read and claim (the predicate is in each statement) and is marked
-- `expired` lazily, the next time that member speaks.
--
-- States: open -> consumed (a clarification answered), superseded (newer
-- context or an unrelated reply), expired (the window lapsed). One-way:
-- nothing moves a row back to open.

CREATE TABLE conversation_continuations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id),
  -- The member who was asked. users is a platform table (outside RLS), so
  -- this is a plain key; membership in this business is checked by the
  -- caller when it resolves the sender.
  user_id            uuid NOT NULL REFERENCES users(id),
  -- The inbound message whose answer opened this row: provenance, and the
  -- replay guard (one row per message). Composite, so another tenant's
  -- message is unrepresentable (the 0141 pattern).
  source_message_id  uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN ('clarification', 'query')),
  expects            text CHECK (expects IN ('period', 'choice')),
  topic              text CHECK (topic IN ('debtors', 'customer_balance', 'supplier_balances',
                                           'sales_summary', 'expenses_summary', 'unreconciled',
                                           'report_request')),
  period             text CHECK (period IN ('today', 'week', 'month', 'last_month')),
  customer_token     text CHECK (customer_token ~ '^CUSTOMER_[A-Z0-9]{2,12}$'),
  document_ref       text CHECK (document_ref ~ '^[A-Z]{2,4}-[0-9]{4}-[0-9]{6}$'),
  options            jsonb CHECK (options IS NULL
                                  OR (jsonb_typeof(options) = 'array'
                                      AND jsonb_array_length(options) BETWEEN 1 AND 9)),
  state              text NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open', 'consumed', 'superseded', 'expired')),
  -- Ordering authority for "newest", assigned by PostgreSQL (the 0149
  -- pattern): never clock resolution, never uuid order.
  insertion_seq      bigint GENERATED ALWAYS AS IDENTITY,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at         timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '600 seconds'),
  CONSTRAINT conversation_continuations_message_business_fk
    FOREIGN KEY (business_id, source_message_id)
    REFERENCES conversation_messages (business_id, id),
  -- A clarification always says what answers it; a query continuation never
  -- does. A numbered list always carries its lines; nothing else carries any.
  CONSTRAINT conversation_continuations_shape_check CHECK (
    (kind = 'clarification' AND expects IS NOT NULL AND customer_token IS NULL
       AND document_ref IS NULL AND period IS NULL)
    OR (kind = 'query' AND expects IS NULL AND topic IS NOT NULL AND options IS NULL)
  ),
  CONSTRAINT conversation_continuations_choice_lines_check CHECK (
    (expects = 'choice') = (options IS NOT NULL)
  )
);

CREATE UNIQUE INDEX conversation_continuations_message_ux
  ON conversation_continuations (source_message_id);

-- Newest wins: at most one open row per member of a business.
CREATE UNIQUE INDEX conversation_continuations_open_ux
  ON conversation_continuations (business_id, user_id) WHERE state = 'open';

-- 0001's ALTER DEFAULT PRIVILEGES granted both application roles full DML.
-- A continuation is retired by state, never deleted by the application: the
-- question Rekoda asked is part of the conversation's history, like a draft.
REVOKE DELETE ON conversation_continuations FROM rekoda_app;
REVOKE DELETE ON conversation_continuations FROM rekoda_worker;

ALTER TABLE conversation_continuations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_continuations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversation_continuations
  USING (business_id = nullif(current_setting('app.business_id', true), '')::uuid);
