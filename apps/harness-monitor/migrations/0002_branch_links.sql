-- Which pull request, issue and engineer each branch belongs to, pulled hourly
-- from GitHub. Expand-only: it adds tables and an index and changes none.
CREATE TABLE branch_links (
  branch TEXT PRIMARY KEY NOT NULL,   -- the pull request's head branch
  pr_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,                -- OPEN, CLOSED or MERGED
  merged_at TEXT,                     -- ISO time, null unless merged
  issue_number INTEGER,               -- the issue the pull request closes, if any
  engineer TEXT,                      -- the author's GitHub login
  pr_updated_at TEXT NOT NULL,        -- ISO time; the newest-updated pull request wins a branch
  linked_at INTEGER NOT NULL          -- epoch milliseconds
);

-- One row, id 1. cursor is the updated time of the newest pull request read;
-- last_success_at is when the job last finished having caught up with GitHub.
-- Both move only in the batch that stores the links they describe.
CREATE TABLE link_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  cursor TEXT,
  last_success_at INTEGER
);

CREATE INDEX usage_requests_occurred ON usage_requests (occurred_at);
