-- Cycle time's merged pull requests, with the rounds of checks each took, as the
-- nightly `Cycle time` job computes and sends them (src/cycle-time.ts). A pull
-- request is the unit: a send replaces its row and every round, check and
-- failing step or test file stored under it.
-- Expand-only: adds tables and changes no existing row.
--
-- A column that is null where the work was never recorded is null, never zero:
-- a pull request with no session record has no writing and no local time.
CREATE TABLE cycle_time_pulls (
  pull_number INTEGER PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  merged_at INTEGER NOT NULL,               -- epoch milliseconds
  base TEXT NOT NULL,                       -- the branch it merged into
  head TEXT,
  landing INTEGER NOT NULL CHECK (landing IN (0, 1)),  -- a feature branch landing on the trunk, whose units are counted already
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  changed_files INTEGER NOT NULL,
  commits INTEGER NOT NULL,
  main_merges INTEGER NOT NULL,
  started_at INTEGER NOT NULL,              -- epoch milliseconds
  start_from TEXT NOT NULL CHECK (start_from IN ('session-record', 'first-commit')),
  recorded INTEGER NOT NULL CHECK (recorded IN (0, 1)),  -- whether the pull request body held a session record
  coding_ms INTEGER,                        -- writing, local checks taken out; null = not recorded
  local_ms INTEGER,                         -- local reviews, test runs and the browser pass inside the writing; null = not recorded
  ci_ms INTEGER NOT NULL,                   -- the rounds of checks, summed
  waiting_to_merge_ms INTEGER,              -- null when no check ran
  away_ms INTEGER NOT NULL,
  total_ms INTEGER NOT NULL,
  review_count INTEGER,                     -- null = the record marked none
  review_ms INTEGER,
  test_runs INTEGER,
  test_ms INTEGER,
  browser_runs INTEGER,
  browser_ms INTEGER,
  runner_ms INTEGER NOT NULL,
  superseded_runs INTEGER NOT NULL,         -- cancelled by a newer push
  superseded_ms INTEGER NOT NULL,
  cancelled_runs INTEGER NOT NULL,          -- cancelled for any other reason
  cancelled_ms INTEGER NOT NULL,
  received_at INTEGER NOT NULL              -- epoch milliseconds of the send that stored it
);
CREATE INDEX cycle_time_pulls_merged ON cycle_time_pulls (merged_at);

CREATE TABLE cycle_time_rounds (
  pull_number INTEGER NOT NULL,
  round_index INTEGER NOT NULL,             -- its place among the pull request's rounds, from 0
  sha TEXT NOT NULL,
  pushed_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  red INTEGER NOT NULL CHECK (red IN (0, 1)),
  commits INTEGER NOT NULL,                 -- the commits that went out in this push
  queue_not_recorded INTEGER NOT NULL CHECK (queue_not_recorded IN (0, 1)),
  PRIMARY KEY (pull_number, round_index)
);

-- One check attempt that ran in a round, in the order they finished.
CREATE TABLE cycle_time_checks (
  pull_number INTEGER NOT NULL,
  round_index INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- its place in the round, from 0
  name TEXT NOT NULL,
  attempt INTEGER NOT NULL,                 -- 1 for the first attempt of the check on the commit, 2 for a re-run
  held_ms INTEGER NOT NULL,                 -- the time it held the round up
  is_last INTEGER NOT NULL CHECK (is_last IN (0, 1)),  -- the one that finished the round
  failure TEXT CHECK (failure IN ('red', 'fluke')),    -- null for an attempt that did not fail
  fluke_ms INTEGER,                         -- the minutes a re-run added, on the first failed attempt of a fluke
  queued_ms INTEGER,                        -- its wait for a runner; null = not recorded
  detail_not_recorded INTEGER NOT NULL CHECK (detail_not_recorded IN (0, 1)),
  no_file_failed INTEGER NOT NULL CHECK (no_file_failed IN (0, 1)),
  PRIMARY KEY (pull_number, round_index, position)
);

-- The step or the test file a failed attempt died on.
CREATE TABLE cycle_time_failures (
  pull_number INTEGER NOT NULL,
  round_index INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- the check's, as above
  kind TEXT NOT NULL CHECK (kind IN ('step', 'file')),
  item_index INTEGER NOT NULL,              -- its place among the attempt's steps or files, from 0
  item TEXT NOT NULL,
  PRIMARY KEY (pull_number, round_index, position, kind, item_index)
);
