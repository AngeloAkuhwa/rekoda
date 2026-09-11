-- A refund the PROVIDER executed before it ever paid the money out (G-06).
--
-- 0092 gave a refund two places the money could physically leave from:
-- the bank or the till. A refund Paystack processes against an unsettled
-- charge leaves from neither: the money is still in the connection's
-- clearing account, and the payout that follows is simply smaller. That is
-- a third place, named here so the posting can credit the account the
-- money actually sat in (DR Accounts Receivable · CR Provider Clearing)
-- instead of crediting a bank that never received it.
--
-- Still one refund model: the record is the same fact, "money returned
-- deliberately"; `method` only says where it left from.
ALTER TABLE refunds DROP CONSTRAINT refunds_method_check;
ALTER TABLE refunds ADD CONSTRAINT refunds_method_check
  CHECK (method IN ('bank', 'cash', 'provider'));
