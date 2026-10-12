-- Expand-only: adds a table and an index, changes no row. The costs page's
-- dollars with two more keys, where each request ran and whether a subagent
-- made it, so the page can split and filter by model, place and agent.
-- Derived like daily_branch_totals: updated in the batch that stores the rows
-- and rebuilt nightly from them. A request with no branch is the branch ''.
-- category is the phase as phaseSql in validate.ts reads it: a Building request
-- dated before phase marks existed (2026-09-21) counts as unphased.
-- daily_branch_totals stays until a later change drops it; requests stored
-- between this migration and the deploy reach only that table until the next
-- nightly rebuild.
CREATE TABLE daily_split_totals (
  day TEXT NOT NULL,
  branch TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  ran_where TEXT NOT NULL,                  -- local, cloud or actions
  subagent INTEGER NOT NULL,                -- 1 for a subagent's request, 0 for a main session's
  requests INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,             -- priced requests only, in millionths of a dollar
  unpriced_requests INTEGER NOT NULL,
  unpriced_input_tokens INTEGER NOT NULL,
  unpriced_output_tokens INTEGER NOT NULL,
  unpriced_cache_creation_tokens INTEGER NOT NULL,
  unpriced_cache_read_tokens INTEGER NOT NULL,
  last_at INTEGER NOT NULL,                 -- epoch milliseconds of the newest request counted
  PRIMARY KEY (day, branch, category, model, ran_where, subagent)
);

-- Everything stored so far, counted once. The table is derived and rebuilt
-- nightly, so this rewrites nothing that is not rebuilt.
INSERT INTO daily_split_totals (
  day, branch, category, model, ran_where, subagent, requests, cost_micros, unpriced_requests,
  unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at
)
SELECT day, COALESCE(branch, ''), CASE WHEN category = 'building' AND day < '2026-09-21' THEN 'unphased' ELSE category END,
       model, ran_where, subagent, COUNT(*), SUM(COALESCE(cost_micros, 0)), SUM(cost_micros IS NULL),
       SUM(CASE WHEN cost_micros IS NULL THEN input_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN output_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_creation_tokens ELSE 0 END),
       SUM(CASE WHEN cost_micros IS NULL THEN cache_read_tokens ELSE 0 END),
       MAX(occurred_at)
FROM usage_requests
GROUP BY day, COALESCE(branch, ''), CASE WHEN category = 'building' AND day < '2026-09-21' THEN 'unphased' ELSE category END, model, ran_where, subagent;

-- The unpriced warning reads only these rows, which are few, on every page view.
CREATE INDEX daily_split_totals_unpriced ON daily_split_totals (model) WHERE unpriced_requests > 0;
