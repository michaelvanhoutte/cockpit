-- One row per Claude Code request, keyed by its request id: a request already
-- stored is ignored, so re-sends, uploads and forked sessions never count twice.
CREATE TABLE usage_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL, -- epoch milliseconds
  day TEXT NOT NULL,            -- UTC day, YYYY-MM-DD
  branch TEXT,
  category TEXT NOT NULL,
  review_level TEXT,            -- only with category local-code-review
  model TEXT NOT NULL,
  speed TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  subagent INTEGER NOT NULL,
  ran_where TEXT NOT NULL,
  source TEXT NOT NULL,
  ingest_id TEXT NOT NULL,      -- the write that stored this row
  received_at INTEGER NOT NULL
);
CREATE INDEX usage_requests_ingest ON usage_requests (ingest_id);
CREATE INDEX usage_requests_day ON usage_requests (day);

-- Everything a screen reads. Updated in the same batch as the rows and rebuilt
-- nightly from them.
CREATE TABLE daily_totals (
  day TEXT NOT NULL,
  category TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  PRIMARY KEY (day, category, model)
);
