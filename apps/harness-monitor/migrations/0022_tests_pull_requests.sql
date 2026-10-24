-- Open pull requests' tests join `main`'s in the tables of 0021, each under
-- `pr-<number>`. Hourly linking deletes a merged or closed pull request's
-- snapshot with one statement on tests_trees (src/tests-store.ts,
-- CLOSED_SNAPSHOTS), since its run is held to 50 queries; this trigger takes
-- the tree's source lines and switch with it. Every other deletion of a tree
-- already deletes those first, so it finds nothing more there.
-- Expand-only: adds a trigger and changes no existing row.
CREATE TRIGGER tests_trees_deleted AFTER DELETE ON tests_trees
BEGIN
  DELETE FROM tests_area_lines WHERE snapshot = OLD.snapshot AND commit_sha = OLD.commit_sha;
  DELETE FROM tests_current WHERE snapshot = OLD.snapshot AND commit_sha = OLD.commit_sha;
END;
