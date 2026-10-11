-- Expand-only: adds a table and an index, changes none. Everything the costs
-- page reads, so that a page view never touches usage_requests: dollars by
-- day, branch, category and model, with the unpriced tokens the warning names.
-- Derived like daily_totals: updated in the batch that stores the rows and
-- rebuilt nightly from them. A request with no branch is the branch ''.
CREATE TABLE daily_branch_totals (
  day TEXT NOT NULL,
  branch TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,             -- priced requests only, in millionths of a dollar
  unpriced_requests INTEGER NOT NULL,
  unpriced_input_tokens INTEGER NOT NULL,
  unpriced_output_tokens INTEGER NOT NULL,
  unpriced_cache_creation_tokens INTEGER NOT NULL,
  unpriced_cache_read_tokens INTEGER NOT NULL,
  last_at INTEGER NOT NULL,                 -- epoch milliseconds of the newest request counted
  PRIMARY KEY (day, branch, category, model)
);

-- Everything stored so far, counted once. The table is derived and rebuilt
-- nightly, so this rewrites nothing that is not rebuilt.
INSERT INTO daily_branch_totals (
  day, branch, category, model, requests, cost_micros, unpriced_requests,
  unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at
)
SELECT day, COALESCE(branch, ''), category, model, COUNT(*), SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL),
       SUM(CASE WHEN cost_micros IS NULL THEN input_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN output_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_creation_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_read_tokens ELSE 0 END),
       MAX(occurred_at)
FROM usage_requests GROUP BY day, COALESCE(branch, ''), category, model;

-- The costs page joins these to branch_links by branch.
CREATE INDEX branch_links_engineer ON branch_links (engineer);
