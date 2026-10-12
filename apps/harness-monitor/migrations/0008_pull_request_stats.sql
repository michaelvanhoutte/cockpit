-- What the hourly linking job reads of each pull request beyond its link: its
-- size, timing, CI rounds and closing issue's title. One row per pull request,
-- derived from GitHub and rewritten by the job. Expand-only: adds a table and a
-- column and changes no row.
CREATE TABLE pull_request_stats (
  pr_number INTEGER PRIMARY KEY NOT NULL,
  lines_added INTEGER,            -- null until the job has read every changed file
  lines_removed INTEGER,          -- lockfiles, snapshots and generated files left out (src/excluded-files.json)
  opened_at TEXT,                 -- ISO time; when it merged is branch_links.merged_at
  ci_rounds INTEGER,              -- head commits pushed after it opened
  issue_title TEXT,               -- the closing issue's title, null when it closes none
  pr_updated_at TEXT NOT NULL,    -- ISO time; an older read never replaces a newer one
  read_at INTEGER NOT NULL        -- epoch milliseconds
);

-- The sizing version of the last run that rewound the place: a deployment whose
-- code carries a newer version re-reads every pull request once (src/linking.ts).
ALTER TABLE link_state ADD COLUMN sizing_version INTEGER;
