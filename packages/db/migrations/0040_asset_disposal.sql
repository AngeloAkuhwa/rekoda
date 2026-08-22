-- Selling or scrapping equipment (ADR 0026, amended).
--
-- 0039 allowed two states: 'recorded' and 'withdrawn'. Withdrawn means the
-- purchase should never have been recorded, and its posting is MIRRORED so
-- the books return to where they were. Selling is a different event entirely:
-- the business really did own the thing, really did use it, and really did
-- get something back for it. Reversing the purchase would erase months of
-- depreciation that genuinely reached the profit and loss.
--
-- So a third state, and the constraint is widened rather than replaced,
-- because every existing row is one of the first two and none of them mean
-- anything different now.
ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_asset_status;
ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_asset_status
  CHECK (status IN ('recorded', 'withdrawn', 'sold'));

-- What came back, kept on the row so the register can say it without reading
-- the posting. NULL for anything not sold, which is every row that exists.
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS proceeds_k bigint;
ALTER TABLE fixed_assets ADD COLUMN IF NOT EXISTS sold_on date;

-- Zero is a real answer: a generator that died is scrapped for nothing, and
-- that is not the same as a row that was never sold.
ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_asset_proceeds;
ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_asset_proceeds
  CHECK (proceeds_k IS NULL OR proceeds_k >= 0);

-- Sold and scrapped rows both carry a day; nothing else does.
ALTER TABLE fixed_assets DROP CONSTRAINT IF EXISTS fixed_asset_sold_shape;
ALTER TABLE fixed_assets
  ADD CONSTRAINT fixed_asset_sold_shape
  CHECK (
    (status = 'sold' AND proceeds_k IS NOT NULL AND sold_on IS NOT NULL)
    OR (status <> 'sold' AND proceeds_k IS NULL AND sold_on IS NULL)
  );
