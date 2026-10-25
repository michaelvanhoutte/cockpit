-- Contract: drops daily_split_totals, which daily_credited_totals (0025) replaced.
-- Nothing has read or written it since the release that moved every reader and
-- writer to daily_credited_totals (#1561), and it is derived from usage_requests,
-- so no stored row is lost. Its unpriced index goes with the table. The floor for
-- promotion back is this release: an older commit still writes this table, so
-- rolling back past it is a restore, not a promotion (docs/deployment.md,
-- "Migrations and rollback").
DROP INDEX IF EXISTS daily_split_totals_unpriced;
DROP TABLE IF EXISTS daily_split_totals;
