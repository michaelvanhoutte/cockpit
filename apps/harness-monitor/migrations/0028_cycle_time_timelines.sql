-- Each cycle time pull request's timeline, beside cycle_time_pulls: what its
-- page's strip needs that the Monitor does not already store. One JSON document
-- per pull request, holding each round's CI job lanes (null for a round whose
-- job list was not read) and the local review and run slices (src/cycle-time.ts,
-- `CycleTimeline`). Its own table, since the list pages read cycle_time_pulls
-- whole and would read every timeline with it.
-- Expand-only: adds a table and changes no existing row.
--
-- Two sends write it. The nightly send replaces a pull request's timeline in the
-- same batch as the pull request, and a pull request sent without one is left
-- with none. The timeline-only send (`POST /v1/cycle-time/timelines`, the backfill)
-- adds timelines beside pull requests already stored, never touching the pull.
--
-- Failure modes:
-- - Stops halfway: each batch is one D1 batch, applied whole or not at all, so the
--   batches before a failure keep their timelines and the later pull requests have
--   none until a re-run.
-- - Runs twice: a timeline is replaced by the same one, and the timeline-only send
--   touches no pull request, round or check, so a re-run loses nothing.
-- - Rows that break the rule: a stored pull request with no timeline is not
--   recorded. A timeline whose round count differs from its pull request's, or
--   for a pull request not stored, is refused whole, naming it, never stored.
-- - The nightly job and the backfill writing the same pull request: either order
--   ends with a timeline worked out from the same GitHub data, since a merged pull
--   request's rounds do not change.
CREATE TABLE cycle_time_timelines (
  pull_number INTEGER PRIMARY KEY NOT NULL,
  timeline TEXT NOT NULL,                   -- the JSON document: {lanes, reviewSlices, runSlices}
  received_at INTEGER NOT NULL              -- epoch milliseconds of the send that stored it
);
