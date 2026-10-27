-- The test explorer's latest snapshot, as documents rather than rows
-- (src/tests.ts): per snapshot, one gzipped tree of areas, rules and cases
-- without source lines, and one gzipped document of each area's source lines.
-- A snapshot is written under its commit across many requests and shown only
-- once `tests_current` names it, which one statement sets after every part has
-- arrived; the same batch deletes every other commit's parts.
-- `snapshot` is `main` today; open pull requests' snapshots join it later.
-- Expand-only: adds tables and changes no existing row.
CREATE TABLE tests_trees (
  snapshot TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  document BLOB NOT NULL,                   -- the gzipped tree, as sent
  areas TEXT NOT NULL,                      -- the JSON array of the area keys the tree names: the parts it waits for
  received_at INTEGER NOT NULL,             -- epoch milliseconds
  PRIMARY KEY (snapshot, commit_sha)
);

CREATE TABLE tests_area_lines (
  snapshot TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  area TEXT NOT NULL,                       -- the area's key in the tree
  document BLOB NOT NULL,                   -- the gzipped source lines, as sent
  received_at INTEGER NOT NULL,
  PRIMARY KEY (snapshot, commit_sha, area)
);

CREATE TABLE tests_current (
  snapshot TEXT PRIMARY KEY NOT NULL,
  commit_sha TEXT NOT NULL,
  made_current_at INTEGER NOT NULL
);
