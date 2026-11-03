-- REM-04: validates the check added NOT VALID in 0187. VALIDATE takes only SHARE UPDATE EXCLUSIVE
-- (reads and writes continue) and runs in its own migration transaction, separate from the ADD.
-- Every existing row has all five payment columns NULL, so it passes.
ALTER TABLE businesses VALIDATE CONSTRAINT businesses_payment_instruction_all_or_nothing;
