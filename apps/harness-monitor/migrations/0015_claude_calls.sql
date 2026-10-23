-- Cockpit's Claude calls, copied from production's record every 12 hours ("Copy
-- Cockpit's Claude calls into the Harness Monitor every 12 hours, and drop them
-- after 12 months", issue 1482). Expand-only: adds four tables and changes no
-- row, so a failure leaves them added or not, and code that predates it never
-- reads them.

-- One copy per call, keyed by production's own row number, so a call served
-- twice is stored once. The columns are the ones production's route sends: the
-- time as epoch milliseconds, the cost as production gave it in millionths of a
-- dollar (NULL where production has no price, never 0). The nightly rebuild
-- deletes a copy 12 months after its call.
CREATE TABLE claude_calls (
  id INTEGER PRIMARY KEY NOT NULL,      -- production's row number
  occurred_at INTEGER NOT NULL,         -- epoch milliseconds
  environment TEXT NOT NULL,            -- production, staging, ci or local
  feature TEXT NOT NULL,
  prompt_version TEXT,
  started_by TEXT,
  model TEXT NOT NULL,
  outcome TEXT NOT NULL,                -- ok, error or timed-out
  tokens_in INTEGER,
  cache_read INTEGER,
  cache_write INTEGER,
  tokens_out INTEGER,
  cost_micros INTEGER,
  pull_request INTEGER,
  run_id INTEGER,                       -- the CI run of a contract run's call
  branch TEXT,                          -- the branch of a local call
  ingest_id TEXT NOT NULL,              -- the import run that stored it
  copied_at INTEGER NOT NULL            -- epoch milliseconds
);
CREATE INDEX claude_calls_ingest ON claude_calls (ingest_id);
CREATE INDEX claude_calls_occurred ON claude_calls (occurred_at);

-- What a page of Cockpit's Claude calls reads: calls and dollars by Belgian
-- day, environment, feature, model, started by, pull request and CI run, added
-- in the batch that stores the copies, from the copies it inserted, and rebuilt
-- nightly. The run is a key so contract runs per pull request can be counted
-- from here alone. None is '' for started_by and 0 for pull_request and run_id.
CREATE TABLE claude_call_daily_totals (
  day TEXT NOT NULL,
  environment TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  started_by TEXT NOT NULL,
  pull_request INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,         -- priced calls only
  unpriced_calls INTEGER NOT NULL,
  PRIMARY KEY (day, environment, feature, model, started_by, pull_request, run_id)
);

-- The last production row number copied, where the next import continues.
CREATE TABLE claude_call_place (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_id INTEGER NOT NULL
);

-- The import's last run, as job_runs holds the other jobs': that table's CHECK
-- names its three jobs, and widening it would rebuild the table.
CREATE TABLE claude_call_job_runs (
  job TEXT PRIMARY KEY NOT NULL CHECK (job = 'claude-calls'),
  ran_at INTEGER NOT NULL,
  started_by TEXT NOT NULL CHECK (started_by IN ('schedule', 'hand')),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  message TEXT NOT NULL,
  last_ok_at INTEGER
);
