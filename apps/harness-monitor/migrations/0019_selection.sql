-- Test selection's pull requests, as the nightly `Selection` job computes and
-- sends them (src/selection.ts): for each merged pull request and each job (Test,
-- E2E) whether it selected a subset, ran everything or was documentation only,
-- the packages and their modes, each selected file with the chain that picked
-- it, and the misses. A pull request is the unit: a send replaces its rows and
-- every row stored under them.
-- Expand-only: adds tables and changes no existing row.
--
-- Only the files a job ran are stored, never the ones it skipped; what a test
-- could have skipped is the pull requests whose package ran in `changed` mode.
CREATE TABLE selection_pulls (
  pull_number INTEGER NOT NULL,
  job TEXT NOT NULL CHECK (job IN ('test', 'e2e')),
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  merged_at INTEGER NOT NULL,               -- epoch milliseconds
  -- ran: the job left a record; docs-only: it never started, the diff touching nothing it checks;
  -- no-record: it left none and has no such excuse, so it is counted in neither direction.
  status TEXT NOT NULL CHECK (status IN ('ran', 'docs-only', 'no-record')),
  ran_everything INTEGER NOT NULL CHECK (ran_everything IN (0, 1)),
  selecting INTEGER NOT NULL CHECK (selecting IN (0, 1)),
  files_run INTEGER,                        -- null unless it ran
  files_total INTEGER,
  pr_duration_ms INTEGER,                   -- the Test job's own time on the pull request and on main's run of its merge; null for E2E
  main_duration_ms INTEGER,
  received_at INTEGER NOT NULL,             -- epoch milliseconds of the send that stored it
  PRIMARY KEY (pull_number, job)
);
CREATE INDEX selection_pulls_merged ON selection_pulls (merged_at);

-- A package of the job and how it ran: everything, or only what the change selected.
CREATE TABLE selection_packages (
  pull_number INTEGER NOT NULL,
  job TEXT NOT NULL,
  name TEXT NOT NULL,
  dir TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'changed')),
  report TEXT NOT NULL CHECK (report IN ('written', 'none')),  -- none: its process died before writing which files ran
  reason_rule TEXT,                         -- why it ran everything, when it did
  reason_path TEXT,                         -- the path that forced it, when one did
  PRIMARY KEY (pull_number, job, name)
);

-- One file the package ran, and why.
CREATE TABLE selection_files (
  pull_number INTEGER NOT NULL,
  job TEXT NOT NULL,
  package TEXT NOT NULL,
  path TEXT NOT NULL,
  level TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
  -- full: the package ran everything; itself: the file changed; chain: reached through imports from a changed file;
  -- concept: an E2E spec of a product area a changed file belongs to; unknown: selected on a trigger the graph does not carry.
  chain_kind TEXT NOT NULL CHECK (chain_kind IN ('full', 'itself', 'chain', 'concept', 'unknown')),
  chain TEXT,                               -- JSON: the paths of a chain, or the owners of a concept
  chain_text TEXT,                          -- the chain in words; null for full
  PRIMARY KEY (pull_number, job, package, path)
);
CREATE INDEX selection_files_path ON selection_files (job, path);

CREATE TABLE selection_changed_files (
  pull_number INTEGER NOT NULL,
  job TEXT NOT NULL,
  path TEXT NOT NULL,
  ignored INTEGER NOT NULL CHECK (ignored IN (0, 1)),  -- a path that never selects anything
  PRIMARY KEY (pull_number, job, path)
);

-- A test that failed on main's run of the merge where the pull request's own run did not run it.
CREATE TABLE selection_misses (
  pull_number INTEGER NOT NULL,
  job TEXT NOT NULL,
  position INTEGER NOT NULL,
  path TEXT NOT NULL,
  level TEXT NOT NULL,
  reason TEXT,                              -- 'docs only' where the pull request ran nothing at all
  PRIMARY KEY (pull_number, job, position)
);

-- The bars the verdicts are judged against, as the latest send carried them: the tool owns the numbers.
CREATE TABLE selection_bars (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  threshold REAL NOT NULL,
  min_over INTEGER,
  window_days INTEGER NOT NULL,
  min_pulls INTEGER NOT NULL,
  alarm_issue INTEGER,                      -- the number of the bar's open alarm issue, null when none is open
  received_at INTEGER NOT NULL
);
