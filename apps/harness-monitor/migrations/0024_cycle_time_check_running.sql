-- Each stored check attempt's running time: the runner time its jobs used, start
-- to end, every shard of a family added up and queueing left out, as the nightly
-- job works it out, so a pull request's attempts add up to its runner_ms for
-- GitHub Actions jobs. Expand-only: adds one nullable column and changes no row.
--
-- Null is not recorded, never zero: an attempt stored before the job sent it.
ALTER TABLE cycle_time_checks ADD COLUMN running_ms INTEGER;
