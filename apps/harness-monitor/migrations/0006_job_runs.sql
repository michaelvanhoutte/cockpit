-- Each scheduled job's last run, whoever started it, for the costs page to say.
-- Expand-only: adds a table and changes none.
CREATE TABLE job_runs (
  job TEXT PRIMARY KEY NOT NULL CHECK (job IN ('linking', 'prices', 'rebuild')),
  ran_at INTEGER NOT NULL,                                  -- epoch milliseconds
  started_by TEXT NOT NULL CHECK (started_by IN ('schedule', 'hand')),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  message TEXT NOT NULL,                                    -- what it did, or the error it met
  last_ok_at INTEGER                                        -- epoch milliseconds of the last run that succeeded
);
