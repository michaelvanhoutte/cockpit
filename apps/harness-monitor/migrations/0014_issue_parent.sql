-- Expand-only: adds two nullable columns, changes no row. The issue's parent (and
-- its title) beside the branch link, read from GitHub by the hourly run, so the
-- by-issue view can group a child's cost under it. Null where the issue has no
-- parent or GitHub has not been asked since this shipped: the run's rewind
-- (SIZING_VERSION 2) re-reads every pull request once and fills them. Code that
-- predates it ignores the columns, so rolling back needs no restore.
ALTER TABLE branch_links ADD COLUMN issue_parent INTEGER;
ALTER TABLE branch_links ADD COLUMN issue_parent_title TEXT;
