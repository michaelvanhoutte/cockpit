-- Additive only: nothing here rewrites or drops a stored row.

-- What each request cost, in millionths of a dollar, fixed when it was priced.
-- NULL means no price: such a row is never counted as free. Rows stored before
-- this migration are NULL until the daily job prices them.
ALTER TABLE usage_requests ADD COLUMN cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_requests ADD COLUMN cost_micros INTEGER;
ALTER TABLE usage_requests ADD COLUMN price_basis TEXT; -- arrival | upload | daily-job; NULL while unpriced
ALTER TABLE usage_requests ADD COLUMN priced_at INTEGER;
CREATE INDEX usage_requests_unpriced ON usage_requests (model) WHERE cost_micros IS NULL;

-- Dollars and the unpriced count join the totals. Every row stored so far is
-- unpriced, so the existing totals say so until the nightly rebuild prices
-- them; otherwise those days would read $0.00, as if free. The totals are
-- derived and rebuilt nightly, so this rewrites nothing that is not rebuilt.
ALTER TABLE daily_totals ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_totals ADD COLUMN unpriced_requests INTEGER NOT NULL DEFAULT 0;
UPDATE daily_totals SET unpriced_requests = requests;

-- The last good price list, one row. A failed fetch writes only the last_*
-- columns, so the list in `models` stays in use.
CREATE TABLE price_list (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  models TEXT,              -- JSON, model -> ModelPrice, as fetched (before the repository's overrides)
  fetched_at INTEGER,       -- when `models` was fetched successfully
  last_attempt_at INTEGER,
  last_error TEXT           -- NULL when the last attempt succeeded
);
