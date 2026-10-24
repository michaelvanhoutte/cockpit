-- Open pull requests' tests join `main`'s in the tables of 0021, each under
-- `pr-<number>`. Hourly linking deletes a merged or closed pull request's
-- snapshot with one statement on tests_trees (src/tests-store.ts,
-- CLOSED_SNAPSHOTS), since its run is held to 50 queries; this trigger takes
-- the tree's source lines and switch with it. Every other deletion of a tree
-- already deletes those first, so it finds nothing more there.
-- The Tests page and that deletion look each stored pull request's links up
-- by number (PULL_REQUESTS_SHOWN, CLOSED_SNAPSHOTS), which the index serves.
-- Expand-only: adds a trigger and an index and changes no existing row.
CREATE TRIGGER tests_trees_deleted AFTER DELETE ON tests_trees
BEGIN
  DELETE FROM tests_area_lines WHERE snapshot = OLD.snapshot AND commit_sha = OLD.commit_sha;
  DELETE FROM tests_current WHERE snapshot = OLD.snapshot AND commit_sha = OLD.commit_sha;
END;

CREATE INDEX branch_links_pr_number ON branch_links (pr_number);
