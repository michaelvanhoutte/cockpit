-- Expand-only: adds two tables, an index and a column, and changes no stored row.
-- A request in a process phase from a branch no pull request names is credited to
-- the linked branch of the nearest request in its session (the next one, else the
-- last before it). The credit is derived: the nightly rebuild decides it from the
-- request rows and the branch links, and nothing writes it between rebuilds.

-- One row per credited request: the linked branch its cost is credited to.
CREATE TABLE request_credits (
  request_id TEXT PRIMARY KEY NOT NULL,
  credit_branch TEXT NOT NULL
);

-- daily_split_totals with the credited branch in its key, as that table replaced
-- daily_branch_totals: SQLite cannot change a key in place. credit_branch is ''
-- for a request under no credit, which is every request until the first rebuild
-- and every request that arrives after it until the next.
CREATE TABLE daily_credited_totals (
  day TEXT NOT NULL,
  branch TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  ran_where TEXT NOT NULL,                  -- local, cloud or actions
  subagent INTEGER NOT NULL,                -- 1 for a subagent's request, 0 for a main session's
  credit_branch TEXT NOT NULL,
  requests INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,             -- priced requests only, in millionths of a dollar
  unpriced_requests INTEGER NOT NULL,
  unpriced_input_tokens INTEGER NOT NULL,
  unpriced_output_tokens INTEGER NOT NULL,
  unpriced_cache_creation_tokens INTEGER NOT NULL,
  unpriced_cache_read_tokens INTEGER NOT NULL,
  last_at INTEGER NOT NULL,                 -- epoch milliseconds of the newest request counted
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  PRIMARY KEY (day, branch, category, model, ran_where, subagent, credit_branch)
);

-- The old totals, every request under no credit, so the page reads the same
-- figures until the first rebuild (run by hand once the deploy lands) credits
-- them. daily_split_totals stays, no longer written, until a later change drops it;
-- rolling back across this reads it stale until that code's own nightly rebuild.
INSERT INTO daily_credited_totals (
  day, branch, category, model, ran_where, subagent, credit_branch, requests, cost_micros, unpriced_requests,
  unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
  input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
)
SELECT day, branch, category, model, ran_where, subagent, '', requests, cost_micros, unpriced_requests,
       unpriced_input_tokens, unpriced_output_tokens, unpriced_cache_creation_tokens, unpriced_cache_read_tokens, last_at,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens
FROM daily_split_totals;

-- The unpriced warning reads only these rows, which are few, on every page view.
CREATE INDEX daily_credited_totals_unpriced ON daily_credited_totals (model) WHERE unpriced_requests > 0;

-- When linking last caught up, as the last rebuild saw it. A branch's newest request
-- newer than this is still "linking…": linking or a rebuild has not caught up with it.
-- Null until a rebuild has run.
ALTER TABLE link_state ADD COLUMN credited_through INTEGER;
