-- Contract: drops daily_branch_totals, which daily_split_totals (0009) replaced.
-- Nothing has read or written it since the release that stopped its writes (#1057),
-- and it is derived from usage_requests, so no stored row is lost. Its unpriced
-- index goes with the table. The floor for promotion back is that release: an
-- older commit still writes this table, so rolling back past it is a restore, not
-- a promotion (docs/deployment.md, "Migrations and rollback").
DROP TABLE IF EXISTS daily_branch_totals;
