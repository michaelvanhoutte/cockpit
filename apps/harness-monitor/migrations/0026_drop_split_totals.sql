-- Contract: drops daily_split_totals, which daily_credited_totals (0025) replaced.
-- Nothing has read or written it since the release that moved every reader and
-- writer to daily_credited_totals (#1561), and it is derived from usage_requests,
-- so no stored row is lost. Its unpriced index goes with the table. The floor for
-- promotion back is #1561, the release that stopped using it: a commit before
-- that still writes this table, so rolling back past #1561 is a restore, not a
-- promotion (docs/deployment.md, "Migrations and rollback").
DROP INDEX IF EXISTS daily_split_totals_unpriced;
DROP TABLE IF EXISTS daily_split_totals;
