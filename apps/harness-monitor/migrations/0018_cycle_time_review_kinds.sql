-- Cycle time's local reviews by kind, beside the combined figure review_count and
-- review_ms already hold, so the page can draw code review and security review
-- apart. Expand-only: adds four nullable columns and an index, and changes no row.
--
-- Null is not recorded, never zero: a row stored before the job sent them, or
-- one whose session record marked no review, has none. A row whose record
-- marked reviews but none of one kind holds 0 for that kind.
ALTER TABLE cycle_time_pulls ADD COLUMN code_review_count INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN code_review_ms INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN security_review_count INTEGER;
ALTER TABLE cycle_time_pulls ADD COLUMN security_review_ms INTEGER;

-- The cycle time page reads each pull request's cost through its branch link by
-- number; without this it scans every link on each view.
CREATE INDEX branch_links_pr ON branch_links (pr_number);
