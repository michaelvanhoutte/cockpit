-- What test selection's page needs to say "ran N of M" and "N changed files
-- placed no walk": each package's total test files (those it ran and those it
-- skipped), and how many of a job's changed files the E2E selection could not
-- place on any walk.
-- Expand-only: adds nullable columns and touches no row. NULL is "not recorded"
-- (a row stored before the job sent them, or a job with no such count), never 0.
ALTER TABLE selection_packages ADD COLUMN files_total INTEGER;
ALTER TABLE selection_pulls ADD COLUMN unplaced_files INTEGER;
