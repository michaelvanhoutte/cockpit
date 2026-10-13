-- Expand-only: adds a table and an index, changes no row. One row per session:
-- its first main-agent request's time, tokens, branch and model, which is what
-- a session starts with before any work. Derived like daily_split_totals:
-- written in the batch that stores the rows (the earliest request wins, the
-- request id breaking a tie) and rebuilt nightly from them. A subagent's
-- request is never a session's start. A request with no branch is the branch ''.
CREATE TABLE session_starts (
  session_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,            -- epoch milliseconds
  day TEXT NOT NULL,                       -- UTC day, YYYY-MM-DD
  branch TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL
);
CREATE INDEX session_starts_day ON session_starts (day);

-- Everything stored so far, counted once. The table is derived and rebuilt
-- nightly, so this rewrites nothing that is not rebuilt.
INSERT INTO session_starts (session_id, request_id, occurred_at, day, branch, model, input_tokens, cache_creation_tokens, cache_read_tokens)
SELECT session_id, request_id, occurred_at, day, COALESCE(branch, ''), model, input_tokens, cache_creation_tokens, cache_read_tokens
FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY occurred_at, request_id) AS n
  FROM usage_requests WHERE subagent = 0
)
WHERE n = 1;
