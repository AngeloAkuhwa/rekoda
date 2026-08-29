-- Conversation backfill (Appendix F.6; W1/W2, PR-058a-2 — step two).
--
-- Legacy conversations are merchant threads: the merchant talking to
-- Rekoda. The backfill sets `conversationKind = MERCHANT` and STOPS
-- THERE. It does not fabricate a customer participant — there was no
-- customer on the other end, there was Rekoda, and inventing a
-- participant hash to fill a column would put a fictional person in the
-- identity index where every later query treats fiction as fact.
--
-- F.8's LEGACY_THREAD is deliberately NOT used here: this estate's
-- provenance is fully established. Every existing row was created by
-- `threadFor`, whose only callers are the merchant Chat and simulator
-- ingresses — the evidence says MERCHANT, so the classification does.
--
-- Validated, not hoped (the 0064 pattern), and idempotent by the WHERE.

UPDATE conversations SET conversation_kind = 'MERCHANT'
WHERE conversation_kind IS NULL;

DO $$
DECLARE unclassified bigint;
BEGIN
  SELECT count(*) INTO unclassified FROM conversations WHERE conversation_kind IS NULL;
  IF unclassified > 0 THEN
    RAISE EXCEPTION 'conversation backfill incomplete: % threads unclassified', unclassified;
  END IF;
END;
$$;
