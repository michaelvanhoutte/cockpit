-- CI stability's runs on `main`, with their jobs and steps, as the Stability job
-- in ci.yml computes and sends them (src/stability.ts). A run is the unit: a
-- send replaces the run's row and every job and step stored under it.
-- Expand-only: adds tables and changes no existing row.
CREATE TABLE stability_runs (
  run_id INTEGER PRIMARY KEY NOT NULL,      -- GitHub's run id
  workflow TEXT NOT NULL,
  path TEXT NOT NULL,                       -- the workflow file
  status TEXT NOT NULL,
  conclusion TEXT,                          -- null while it is still running
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown')),
  head_sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,              -- epoch milliseconds
  url TEXT NOT NULL,
  received_at INTEGER NOT NULL              -- epoch milliseconds of the send that stored it
);
CREATE INDEX stability_runs_created ON stability_runs (created_at);

-- A job as the tool counts it: a shard family is one job under its fan-in's name.
CREATE TABLE stability_jobs (
  run_id INTEGER NOT NULL,
  job_index INTEGER NOT NULL,               -- its place in the run's list as sent
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  conclusion TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail', 'cancelled', 'skipped', 'running', 'other', 'unknown')),
  started_at INTEGER,                       -- epoch milliseconds
  completed_at INTEGER,
  duration_ms INTEGER,                      -- null where it has no whole span
  failed_step TEXT,
  url TEXT,
  PRIMARY KEY (run_id, job_index)
);

CREATE TABLE stability_steps (
  run_id INTEGER NOT NULL,
  job_index INTEGER NOT NULL,
  position INTEGER NOT NULL,                -- its place in the job, from 0
  number INTEGER,                           -- GitHub's step number
  name TEXT NOT NULL,
  occurrence INTEGER NOT NULL,              -- 1 for the first step of its name in the job, 2 for the second
  conclusion TEXT,
  started_at INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,                      -- null where it was skipped, cancelled or has no times
  PRIMARY KEY (run_id, job_index, position)
);
