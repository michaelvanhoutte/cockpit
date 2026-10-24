-- Cycle time's local time split by kind with each minute counted once, as the
-- nightly job works it out, so the four add up to local_ms exactly. The raw
-- per-kind figures (review_ms, code_review_ms, test_ms, browser_ms and the rest)
-- stay as they are. Expand-only: adds four nullable columns and changes no row.
--
-- Null is not split by kind, never zero: a row stored before the job sent them,
-- or one whose local time is null. The code reads only the full set.
ALTER TABLE cycle_time_pulls ADD COLUMN local_code_review_ms INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN local_security_review_ms INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN local_test_ms INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN local_browser_ms INTEGER;
