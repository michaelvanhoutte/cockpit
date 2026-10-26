-- CI stability's attempts, beside the stability_* tables: every attempt of a
-- workflow run is a row of its own, with the branch and pull request it ran
-- for, as the Stability job in ci.yml computes and sends them
-- (src/ci-attempts.ts). An attempt is the unit: a send replaces its row and
-- every job, step, failed job and failed test stored under it. A run on `main`
-- keeps every job and step as stability_jobs does; any attempt keeps its failed
-- jobs, and the tests that failed in each.
-- Expand-only: adds tables and changes no existing row. stability_* is dropped
-- in a follow-up once nothing reads it.
CREATE TABLE ci_attempts (
  run_id INTEGER NOT NULL,                  -- GitHub's run id
  attempt INTEGER NOT NULL,                 -- 1 for the first, 2 for the first re-run
  workflow TEXT NOT NULL,                   -- Dependabot's runs, named for their update, are all 'Dependabot'
  path TEXT NOT NULL,                       -- the workflow file
  event TEXT NOT NULL,
  branch TEXT,
  pull_number INTEGER,                      -- the pull request it ran for, if any
  on_main INTEGER NOT NULL CHECK (on_main IN (0, 1)),  -- main's own runs, scheduled and manual ones included; 0 for a pull request's run or any run on another branch
  head_sha TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,                          -- null while it is still running
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown')),
  created_at INTEGER NOT NULL,              -- epoch milliseconds the attempt started
  url TEXT NOT NULL,
  received_at INTEGER NOT NULL,             -- epoch milliseconds of the send that stored it
  PRIMARY KEY (run_id, attempt)
);
CREATE INDEX ci_attempts_created ON ci_attempts (on_main, created_at);

-- A job as the tool counts it: a shard family is one job under its fan-in's name. Main's attempts only.
CREATE TABLE ci_attempt_jobs (
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  job_index INTEGER NOT NULL,               -- its place in the attempt's list as sent
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown')),
  started_at INTEGER,                       -- epoch milliseconds
  completed_at INTEGER,
  duration_ms INTEGER,                      -- null where it has no whole span
  failed_step TEXT,
  url TEXT,
  PRIMARY KEY (run_id, attempt, job_index)
);

CREATE TABLE ci_attempt_steps (
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  job_index INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- its place in the job, from 0
  number INTEGER,                           -- GitHub's step number
  name TEXT NOT NULL,
  occurrence INTEGER NOT NULL,              -- 1 for the first step of its name in the job, 2 for the second
  conclusion TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,                      -- null where it was skipped, cancelled or has no times
  PRIMARY KEY (run_id, attempt, job_index, position)
);

-- A job of the attempt that failed, whichever branch it ran for: a shard family is one failed job, and a fan-in that failed only because a shard did is not another.
CREATE TABLE ci_failed_jobs (
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- its place among the attempt's failed jobs, from 0
  name TEXT NOT NULL,
  step TEXT,                                -- the step it died on; null where none is recorded
  url TEXT,
  tests_more INTEGER NOT NULL,              -- failed tests its record counted without naming
  PRIMARY KEY (run_id, attempt, position)
);

-- The tests that failed in a failed job, as its record names them; none where the job kept no record.
CREATE TABLE ci_failed_tests (
  run_id INTEGER NOT NULL,
  attempt INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- the failed job's
  test_index INTEGER NOT NULL,              -- its place in the record, from 0
  file TEXT NOT NULL,
  name TEXT NOT NULL,                       -- describe blocks and test name, as the record writes it
  project TEXT,                             -- the Playwright project; null for Vitest
  error TEXT,                               -- the first line of the error; null where it had no message
  PRIMARY KEY (run_id, attempt, position, test_index)
);
